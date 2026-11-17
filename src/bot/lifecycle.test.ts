import { describe, expect, spyOn, test } from 'bun:test';
import type { ChatInputCommandInteraction } from 'discord.js';
import logger from './utils/logger';
import {
  createShutdown,
  DM_FAILURE_NOTICE,
  runChatCommand,
  type ChatCommandDeps,
  type ShutdownDeps,
} from './lifecycle';

function shutdownDeps(over: Partial<ShutdownDeps> = {}) {
  const order: string[] = [];
  const deps: ShutdownDeps = {
    stopScheduler: async () => void order.push('scheduler'),
    destroyClient: async () => void order.push('client'),
    closeDatabase: async () => void order.push('database'),
    exit: (code) => void order.push(`exit ${code}`),
    graceMs: 50,
    ...over,
  };
  return { deps, order };
}

describe('createShutdown', () => {
  test('stops scheduler, client and database in that order, then exits', async () => {
    const { deps, order } = shutdownDeps();
    const s = createShutdown(deps);
    expect(s.isShuttingDown()).toBe(false);
    await s.shutdown('SIGTERM', 0);
    expect(s.isShuttingDown()).toBe(true);
    expect(order).toEqual(['scheduler', 'client', 'database', 'exit 0']);
  });

  test('a second signal does nothing', async () => {
    const { deps, order } = shutdownDeps();
    const s = createShutdown(deps);
    await Promise.all([s.shutdown('SIGINT', 0), s.shutdown('SIGTERM', 0)]);
    expect(order.filter((o) => o.startsWith('exit'))).toEqual(['exit 0']);
  });

  test('a later call during the shutdown raises the exit code but runs nothing twice', async () => {
    let release = () => {};
    const { deps, order } = shutdownDeps({
      stopScheduler: () => new Promise<void>((resolve) => (release = resolve)),
      graceMs: 1000,
    });
    const s = createShutdown(deps);
    const first = s.shutdown('SIGTERM', 0);
    await s.shutdown('uncaught exception', 1);
    release();
    await first;
    expect(order).toEqual(['client', 'database', 'exit 1']);
  });

  test('a check still running after the grace time does not hold up the exit', async () => {
    const warn = spyOn(logger, 'warn');
    try {
      const { deps, order } = shutdownDeps({ stopScheduler: () => new Promise(() => {}) });
      await createShutdown(deps).shutdown('SIGTERM', 0);
      expect(order).toEqual(['client', 'database', 'exit 0']);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('still running'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test('a failing step still closes the rest and exits with 1', async () => {
    const log = spyOn(logger, 'log');
    try {
      const { deps, order } = shutdownDeps({
        destroyClient: async () => {
          throw new Error('gateway');
        },
      });
      await createShutdown(deps).shutdown('SIGTERM', 0);
      expect(order).toEqual(['scheduler', 'database', 'exit 1']);
    } finally {
      log.mockRestore();
    }
  });

  test('the requested exit code is kept when it is already non-zero', async () => {
    const { deps, order } = shutdownDeps();
    await createShutdown(deps).shutdown('login failed', 1);
    expect(order.at(-1)).toBe('exit 1');
  });
});

describe('runChatCommand', () => {
  function fakeInteraction(opts: { replies?: boolean; failFollowUp?: boolean } = {}) {
    const followUps: unknown[] = [];
    const self = {
      commandName: 'missing',
      user: { id: 'u1', tag: 'bob#1' },
      replied: false,
      deferred: false,
      isChatInputCommand: () => true,
      reply: async () => {
        self.replied = true;
      },
      editReply: async () => {},
      followUp: async (p: unknown) => {
        if (opts.failFollowUp) throw new Error('unknown interaction');
        followUps.push(p);
      },
    };
    return { interaction: self as unknown as ChatInputCommandInteraction, followUps, self };
  }

  function deps(
    flag: { failed: boolean },
    execute: ChatCommandDeps['commands'][string]['execute']
  ) {
    return {
      commands: { missing: { execute } },
      hasDmFailure: () => flag.failed,
      clearDmFailure: () => {
        flag.failed = false;
      },
    } satisfies ChatCommandDeps;
  }

  test('adds the DM failure notice after the reply and clears the flag', async () => {
    const { interaction, followUps } = fakeInteraction();
    const flag = { failed: true };
    await runChatCommand(
      interaction,
      deps(flag, async (i) => {
        await i.reply('ok');
      })
    );
    expect(followUps).toEqual([{ content: DM_FAILURE_NOTICE, flags: 64 }]);
    expect(flag.failed).toBe(false);
  });

  test('a command that did not reply keeps the flag for the next command', async () => {
    const { interaction, followUps } = fakeInteraction();
    const flag = { failed: true };
    await runChatCommand(
      interaction,
      deps(flag, async () => {})
    );
    expect(followUps).toEqual([]);
    expect(flag.failed).toBe(true);
  });

  test('a failed follow-up keeps the flag', async () => {
    const warn = spyOn(logger, 'log');
    try {
      const { interaction } = fakeInteraction({ failFollowUp: true });
      const flag = { failed: true };
      await runChatCommand(
        interaction,
        deps(flag, async (i) => {
          await i.reply('ok');
        })
      );
      expect(flag.failed).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test('a failing command gets the error reply, and the flag read failing is logged at error', async () => {
    const log = spyOn(logger, 'log');
    try {
      const { interaction, self } = fakeInteraction();
      const replies: unknown[] = [];
      self.reply = async (p?: unknown) => {
        replies.push(p);
        self.replied = true;
      };
      await runChatCommand(interaction, {
        commands: {
          missing: {
            execute: async () => {
              throw new Error('boom');
            },
          },
        },
        hasDmFailure: () => {
          throw new Error('database is locked');
        },
        clearDmFailure: () => {},
      });
      expect(replies).toHaveLength(1);
      const levels = (log.mock.calls as unknown[][])
        .filter((c) => String(c[1]).includes('DM failure flag'))
        .map((c) => c[0]);
      expect(levels).toEqual(['error']);
    } finally {
      log.mockRestore();
    }
  });

  test('an unknown command does nothing', async () => {
    const { interaction, followUps } = fakeInteraction();
    await runChatCommand(interaction, {
      commands: {},
      hasDmFailure: () => true,
      clearDmFailure: () => {},
    });
    expect(followUps).toEqual([]);
  });
});
