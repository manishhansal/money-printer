import { Test, TestingModule } from '@nestjs/testing';
import { RedisService } from './redis.service';
import { REDIS_CLIENT, REDIS_PUBSUB_CLIENT } from './redis.constants';

/**
 * Creates a minimal mock of ioredis for unit testing.
 * We don't need a real Redis connection — just verify that RedisService
 * delegates to the correct client with the correct arguments.
 */
function createRedisMock() {
  return {
    ping: jest.fn(),
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    expire: jest.fn(),
    publish: jest.fn(),
    subscribe: jest.fn(),
    unsubscribe: jest.fn(),
    quit: jest.fn().mockResolvedValue('OK'),
    on: jest.fn().mockReturnThis(),
  };
}

describe('RedisService', () => {
  let service: RedisService;
  let commandClient: ReturnType<typeof createRedisMock>;
  let pubSubClient: ReturnType<typeof createRedisMock>;

  beforeEach(async () => {
    commandClient = createRedisMock();
    pubSubClient = createRedisMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RedisService,
        { provide: REDIS_CLIENT, useValue: commandClient },
        { provide: REDIS_PUBSUB_CLIENT, useValue: pubSubClient },
      ],
    }).compile();

    service = module.get<RedisService>(RedisService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Health check
  // ---------------------------------------------------------------------------

  describe('isHealthy()', () => {
    it('returns true when command client responds with PONG', async () => {
      commandClient.ping.mockResolvedValue('PONG');
      expect(await service.isHealthy()).toBe(true);
      expect(commandClient.ping).toHaveBeenCalledTimes(1);
    });

    it('returns false when command client responds with something other than PONG', async () => {
      commandClient.ping.mockResolvedValue('');
      expect(await service.isHealthy()).toBe(false);
    });

    it('returns false (does not throw) when the ping command rejects', async () => {
      commandClient.ping.mockRejectedValue(new Error('ECONNREFUSED'));
      expect(await service.isHealthy()).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // get()
  // ---------------------------------------------------------------------------

  describe('get()', () => {
    it('delegates to the command client and returns the value', async () => {
      commandClient.get.mockResolvedValue('test-value');
      const result = await service.get('some:key');
      expect(result).toBe('test-value');
      expect(commandClient.get).toHaveBeenCalledWith('some:key');
    });

    it('returns null when the key does not exist', async () => {
      commandClient.get.mockResolvedValue(null);
      expect(await service.get('missing:key')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // set()
  // ---------------------------------------------------------------------------

  describe('set()', () => {
    it('calls SET without EX when no TTL is provided', async () => {
      commandClient.set.mockResolvedValue('OK');
      await service.set('key', 'value');
      expect(commandClient.set).toHaveBeenCalledWith('key', 'value');
    });

    it('calls SET with EX when a positive TTL is provided', async () => {
      commandClient.set.mockResolvedValue('OK');
      await service.set('key', 'value', 30);
      expect(commandClient.set).toHaveBeenCalledWith('key', 'value', 'EX', 30);
    });

    it('calls SET without EX when TTL is 0 (falsy)', async () => {
      commandClient.set.mockResolvedValue('OK');
      await service.set('key', 'value', 0);
      expect(commandClient.set).toHaveBeenCalledWith('key', 'value');
    });
  });

  // ---------------------------------------------------------------------------
  // del()
  // ---------------------------------------------------------------------------

  describe('del()', () => {
    it('delegates to the command client and returns the delete count', async () => {
      commandClient.del.mockResolvedValue(2);
      const result = await service.del('k1', 'k2');
      expect(result).toBe(2);
      expect(commandClient.del).toHaveBeenCalledWith('k1', 'k2');
    });
  });

  // ---------------------------------------------------------------------------
  // expire()
  // ---------------------------------------------------------------------------

  describe('expire()', () => {
    it('returns true when the TTL was successfully set', async () => {
      commandClient.expire.mockResolvedValue(1);
      expect(await service.expire('key', 60)).toBe(true);
      expect(commandClient.expire).toHaveBeenCalledWith('key', 60);
    });

    it('returns false when the key does not exist', async () => {
      commandClient.expire.mockResolvedValue(0);
      expect(await service.expire('missing', 60)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // publish()
  // ---------------------------------------------------------------------------

  describe('publish()', () => {
    it('delegates to the pub/sub client (NOT the command client)', async () => {
      pubSubClient.publish.mockResolvedValue(3);
      const result = await service.publish('events:tick:NIFTY', '{"ltp":22500}');
      expect(result).toBe(3);
      expect(pubSubClient.publish).toHaveBeenCalledWith('events:tick:NIFTY', '{"ltp":22500}');
      expect(commandClient.publish).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // subscribe()
  // ---------------------------------------------------------------------------

  describe('subscribe()', () => {
    it('registers message handler and subscribes using the pub/sub client', async () => {
      pubSubClient.subscribe.mockResolvedValue(1);
      const handler = jest.fn();

      await service.subscribe('events:regime_change', handler);

      expect(pubSubClient.on).toHaveBeenCalledWith('message', handler);
      expect(pubSubClient.subscribe).toHaveBeenCalledWith('events:regime_change');
      expect(commandClient.subscribe).not.toHaveBeenCalled();
    });

    it('subscribes to multiple channels in one call', async () => {
      pubSubClient.subscribe.mockResolvedValue(2);
      const handler = jest.fn();

      await service.subscribe(['chan:a', 'chan:b'], handler);

      expect(pubSubClient.subscribe).toHaveBeenCalledWith('chan:a', 'chan:b');
    });
  });

  // ---------------------------------------------------------------------------
  // unsubscribe()
  // ---------------------------------------------------------------------------

  describe('unsubscribe()', () => {
    it('unsubscribes from a single channel', async () => {
      pubSubClient.unsubscribe.mockResolvedValue(0);
      await service.unsubscribe('events:tick:NIFTY');
      expect(pubSubClient.unsubscribe).toHaveBeenCalledWith('events:tick:NIFTY');
    });

    it('unsubscribes from all channels when called with no argument', async () => {
      pubSubClient.unsubscribe.mockResolvedValue(0);
      await service.unsubscribe();
      expect(pubSubClient.unsubscribe).toHaveBeenCalledWith();
    });
  });

  // ---------------------------------------------------------------------------
  // Client isolation invariant
  // ---------------------------------------------------------------------------

  describe('client isolation', () => {
    it('pub/sub operations never touch the command client', async () => {
      pubSubClient.publish.mockResolvedValue(0);
      pubSubClient.subscribe.mockResolvedValue(1);
      pubSubClient.unsubscribe.mockResolvedValue(0);

      await service.publish('ch', 'msg');
      await service.subscribe('ch', jest.fn());
      await service.unsubscribe('ch');

      expect(commandClient.publish).not.toHaveBeenCalled();
      expect(commandClient.subscribe).not.toHaveBeenCalled();
      expect(commandClient.unsubscribe).not.toHaveBeenCalled();
    });

    it('command operations never touch the pub/sub client', async () => {
      commandClient.get.mockResolvedValue('v');
      commandClient.set.mockResolvedValue('OK');
      commandClient.del.mockResolvedValue(1);
      commandClient.expire.mockResolvedValue(1);

      await service.get('k');
      await service.set('k', 'v');
      await service.del('k');
      await service.expire('k', 10);

      expect(pubSubClient.get).not.toHaveBeenCalled();
      expect(pubSubClient.set).not.toHaveBeenCalled();
      expect(pubSubClient.del).not.toHaveBeenCalled();
      expect(pubSubClient.expire).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------

  describe('onModuleDestroy()', () => {
    it('quits both clients during module destruction', async () => {
      commandClient.quit.mockResolvedValue('OK');
      pubSubClient.quit.mockResolvedValue('OK');

      await service.onModuleDestroy();

      expect(commandClient.quit).toHaveBeenCalledTimes(1);
      expect(pubSubClient.quit).toHaveBeenCalledTimes(1);
    });

    it('resolves even if one client quit rejects', async () => {
      commandClient.quit.mockRejectedValue(new Error('already disconnected'));
      pubSubClient.quit.mockResolvedValue('OK');

      // Should not throw
      await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    });
  });
});
