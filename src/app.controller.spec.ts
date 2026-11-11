import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SignalScannerService } from './modules/signal-scanner/signal-scanner.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        {
          provide: SignalScannerService,
          useValue: { scanForSignals: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: getDataSourceToken(),
          useValue: {
            query: jest.fn().mockResolvedValue([{ n: '0' }]),
          },
        },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return the CloudEngine running message', () => {
      expect(appController.getHello()).toBe('MoneyPrinter CloudEngine is running.');
    });
  });
});
