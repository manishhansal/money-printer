/**
 * settings.controller.ts
 *
 * GET  /settings  — returns current trading configuration (paper capital, risk %, etc.)
 * PUT  /settings  — updates settings; persists to user_settings table
 *
 * No auth guard: settings are for local/trusted clients only (Chrome Extension on localhost).
 */

import { Body, Controller, Get, Put } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { UserSettings } from '../../database/entities/user-settings.entity';

export class UpdateSettingsDto {
  /** Paper trading starting capital in INR (e.g. 50000 for ₹50,000). */
  paperStartingCapital?: string;
  /** Live trading starting capital in INR. */
  liveStartingCapital?: string;
  /** Risk percentage per trade (e.g. "1.0000" = 1%). */
  defaultRiskPercentage?: string;
  /** Max daily loss percentage of capital (e.g. "2.0000" = 2%). */
  maxDailyLossPercentage?: string;
}

export interface SettingsResponse {
  paperStartingCapital: string;
  liveStartingCapital: string;
  defaultRiskPercentage: string;
  maxDailyLossPercentage: string;
  /** Derived: 1% of paper capital = max risk per trade */
  paperRiskPerTrade: string;
  /** Derived: daily loss limit in rupees = maxDailyLossPercentage% of paper capital */
  paperDailyLossLimitRupees: string;
}

@Controller('settings')
export class SettingsController {
  constructor(
    @InjectRepository(UserSettings)
    private readonly userSettingsRepo: Repository<UserSettings>,
  ) {}

  /**
   * GET /settings
   * Returns current trading settings and auto-derived risk limits.
   */
  @Get()
  async getSettings(): Promise<SettingsResponse> {
    const settings = await this.userSettingsRepo.findOne({ where: {} });

    const paperCapital = parseFloat(settings?.paperStartingCapital ?? '50000.00');
    const liveCapital = parseFloat(settings?.liveStartingCapital ?? '0.00');
    const riskPct = parseFloat(settings?.defaultRiskPercentage ?? '1.0000');
    const dailyLossPct = parseFloat(settings?.maxDailyLossPercentage ?? '2.0000');

    return {
      paperStartingCapital: paperCapital.toFixed(2),
      liveStartingCapital: liveCapital.toFixed(2),
      defaultRiskPercentage: riskPct.toFixed(4),
      maxDailyLossPercentage: dailyLossPct.toFixed(4),
      paperRiskPerTrade: ((paperCapital * riskPct) / 100).toFixed(2),
      paperDailyLossLimitRupees: ((paperCapital * dailyLossPct) / 100).toFixed(2),
    };
  }

  /**
   * PUT /settings
   * Updates the first user_settings row (upsert). Resets the paper portfolio
   * balance in Redis so the new capital takes effect on the next balance read.
   */
  @Put()
  async updateSettings(@Body() dto: UpdateSettingsDto): Promise<SettingsResponse> {
    let settings = await this.userSettingsRepo.findOne({ where: {} });

    if (!settings) {
      settings = this.userSettingsRepo.create({
        userId: 'default',
        paperStartingCapital: '50000.00',
        liveStartingCapital: '0.00',
        defaultRiskPercentage: '1.0000',
        maxDailyLossPercentage: '2.0000',
      });
    }

    if (dto.paperStartingCapital !== undefined) {
      settings.paperStartingCapital = parseFloat(dto.paperStartingCapital).toFixed(2);
    }
    if (dto.liveStartingCapital !== undefined) {
      settings.liveStartingCapital = parseFloat(dto.liveStartingCapital).toFixed(2);
    }
    if (dto.defaultRiskPercentage !== undefined) {
      settings.defaultRiskPercentage = parseFloat(dto.defaultRiskPercentage).toFixed(4);
    }
    if (dto.maxDailyLossPercentage !== undefined) {
      settings.maxDailyLossPercentage = parseFloat(dto.maxDailyLossPercentage).toFixed(4);
    }

    await this.userSettingsRepo.save(settings);

    return this.getSettings();
  }
}
