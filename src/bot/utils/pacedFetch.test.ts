import { describe, expect, test } from 'bun:test';
import { createPacedFetch } from './pacedFetch';

describe('createPacedFetch', () => {
  const paced = new Set(['www.laststicker.com']);
  const setup = () => {
    let clock = 1000;
    const sleeps: number[] = [];
    const urls: string[] = [];
    const fetchFn = async (url: string) => {
      urls.push(url);
      return new Response('ok');
    };
    const f = createPacedFetch(fetchFn, paced, 1500, {
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    return { f, sleeps, urls, tick: (ms: number) => (clock += ms) };
  };

  test('waits delayMs between two requests to a paced host', async () => {
    const { f, sleeps, tick } = setup();
    await f('https://www.laststicker.com/i/cards/12125/1.jpg');
    tick(200);
    await f('https://www.laststicker.com/i/cards/12125/2.jpg');
    expect(sleeps).toEqual([1300]);
  });

  test('does not wait once delayMs has passed', async () => {
    const { f, sleeps, tick } = setup();
    await f('https://www.laststicker.com/a.jpg');
    tick(2000);
    await f('https://www.laststicker.com/b.jpg');
    expect(sleeps).toEqual([]);
  });

  test('does not pace other hosts', async () => {
    const { f, sleeps, urls } = setup();
    await f('https://www.laststicker.com/a.jpg');
    await f('https://i.ebayimg.com/a.jpg');
    await f('https://shop-sammel-ente.de/a.jpg');
    expect(sleeps).toEqual([]);
    expect(urls).toHaveLength(3);
  });

  test('serializes concurrent calls', async () => {
    const { f, sleeps, urls } = setup();
    await Promise.all(['1', '2', '3', '4'].map((n) => f(`https://www.laststicker.com/${n}.jpg`)));
    expect(sleeps).toEqual([1500, 1500, 1500]);
    expect(urls).toHaveLength(4);
  });

  test('a failed request still paces the next one and does not block the queue', async () => {
    const clock = 0;
    const sleeps: number[] = [];
    let calls = 0;
    const f = createPacedFetch(
      async () => {
        calls++;
        if (calls === 1) throw new Error('network down');
        return new Response('ok');
      },
      paced,
      1500,
      { now: () => clock, sleep: async (ms) => void sleeps.push(ms) }
    );
    await expect(f('https://www.laststicker.com/a.jpg')).rejects.toThrow('network down');
    expect((await f('https://www.laststicker.com/b.jpg')).ok).toBe(true);
    expect(sleeps).toEqual([1500]);
  });

  test('an unparsable URL passes through unpaced', async () => {
    const { f, sleeps, urls } = setup();
    await f('not a url');
    expect(urls).toEqual(['not a url']);
    expect(sleeps).toEqual([]);
  });

  test('a failing pacing step rejects that request only, never the later ones', async () => {
    let fail = true;
    let clock = 0;
    const f = createPacedFetch(async () => new Response('ok'), paced, 1500, {
      now: () => clock,
      sleep: async () => {
        if (fail) {
          fail = false;
          throw new Error('timer broke');
        }
      },
    });
    await f('https://www.laststicker.com/a.jpg');
    await expect(f('https://www.laststicker.com/b.jpg')).rejects.toThrow('timer broke');
    clock += 5000;
    expect((await f('https://www.laststicker.com/c.jpg')).ok).toBe(true);
  });
});
