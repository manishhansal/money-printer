import { Test, TestingModule } from '@nestjs/testing';
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
