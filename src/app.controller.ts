import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AppService } from './app.service';
import { SignalScannerService } from './modules/signal-scanner/signal-scanner.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly signalScannerService: SignalScannerService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /**
   * Debug endpoint — manually triggers a signal scan immediately.
   * Remove before production deployment.
   */
  @Get('debug/scan')
  async triggerScan(): Promise<{ status: string; triggeredAt: string }> {
    void this.signalScannerService.scanForSignals();
    return { status: 'scan triggered', triggeredAt: new Date().toISOString() };
  }

  /**
   * Dashboard stats — returns key counts for the browser UI footer.
   * Public, GET-only, no auth required.
   */
  @Get('debug/stats')
  async getStats(): Promise<Record<string, number>> {
    const [evals, orders, fills, instruments] = await Promise.all([
      this.dataSource
        .query('SELECT COUNT(*) n FROM signal_evaluations')
        .then((r) => parseInt(r[0].n)),
      this.dataSource.query('SELECT COUNT(*) n FROM paper_orders').then((r) => parseInt(r[0].n)),
      this.dataSource
        .query('SELECT COUNT(*) n FROM paper_executions')
        .then((r) => parseInt(r[0].n)),
      this.dataSource
        .query('SELECT COUNT(*) n FROM instruments WHERE is_active=true')
        .then((r) => parseInt(r[0].n)),
    ]);
    return { signalEvals: evals, paperOrders: orders, paperFills: fills, instruments };
  }
}
