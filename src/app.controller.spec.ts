import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { RedisService } from './modules/redis/redis.service';

describe('AppController', () => {
  let appController: AppController;
  let mockRedis: { isHealthy: jest.Mock; get: jest.Mock };
  let mockDataSource: { query: jest.Mock };

  beforeEach(async () => {
    mockRedis = {
      isHealthy: jest.fn().mockResolvedValue(true),
      get: jest.fn().mockResolvedValue('Healthy'),
    };
    mockDataSource = {
      query: jest.fn().mockResolvedValue([{ n: '0' }]),
    };

    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        { provide: RedisService, useValue: mockRedis },
        { provide: getDataSourceToken(), useValue: mockDataSource },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('GET /', () => {
    it('should return the CloudEngine running message', () => {
      expect(appController.getHello()).toBe('MoneyPrinter CloudEngine is running.');
    });
  });

  describe('GET /health', () => {
    it('returns status ok when PostgreSQL and Redis are up', async () => {
      mockDataSource.query.mockResolvedValue([{ 1: 1 }]);
      mockRedis.isHealthy.mockResolvedValue(true);
      mockRedis.get.mockResolvedValue('Healthy');

      const result = await appController.getHealth();

      expect(result.status).toBe('ok');
      expect(result.info.postgresql_connection.status).toBe('up');
      expect(result.info.redis_availability.status).toBe('up');
      expect(result.info.dhan_api_connectivity.status).toBe('up');
    });

    it('returns status error when PostgreSQL is down', async () => {
      mockDataSource.query.mockRejectedValue(new Error('connection refused'));
      mockRedis.isHealthy.mockResolvedValue(true);

      const result = await appController.getHealth();

      expect(result.status).toBe('error');
      expect(result.info.postgresql_connection.status).toBe('down');
      expect(result.info.redis_availability.status).toBe('up');
    });

    it('returns status error when Redis is down', async () => {
      mockDataSource.query.mockResolvedValue([{ 1: 1 }]);
      mockRedis.isHealthy.mockResolvedValue(false);

      const result = await appController.getHealth();

      expect(result.status).toBe('error');
      expect(result.info.redis_availability.status).toBe('down');
    });

    it('returns dhan_api_connectivity=down when Redis key is absent', async () => {
      mockDataSource.query.mockResolvedValue([{ 1: 1 }]);
      mockRedis.isHealthy.mockResolvedValue(true);
      mockRedis.get.mockResolvedValue(null);

      const result = await appController.getHealth();

      expect(result.info.dhan_api_connectivity.status).toBe('down');
    });
  });
});
