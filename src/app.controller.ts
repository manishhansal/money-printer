import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { SignalScannerService } from './modules/signal-scanner/signal-scanner.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly signalScannerService: SignalScannerService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /**
   * Debug endpoint — manually triggers a signal scan immediately.
   * Remove before production deployment.
   * No auth guard: only accessible from localhost (CORS policy).
   */
  @Get('debug/scan')
  async triggerScan(): Promise<{ status: string; triggeredAt: string }> {
    void this.signalScannerService.scanForSignals();
    return { status: 'scan triggered', triggeredAt: new Date().toISOString() };
  }
}
