import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): string {
    return 'MoneyPrinter CloudEngine is running.';
  }
}
