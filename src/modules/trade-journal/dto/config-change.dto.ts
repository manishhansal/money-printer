/**
 * ConfigChangeDto — payload for journaling a user-initiated configuration change.
 *
 * Requirement 13.4 mandates: user identifier, timestamp, field name,
 * previous value, and new value in the AuditLogs table.
 *
 * Maps to the `AuditLogs` entity with event_type = 'CONFIG_CHANGE'.
 * The write timestamp is auto-generated to `new Date()` (UTC now) inside
 * `TradeJournalService.insertConfigChange` — callers do not supply it.
 * 5-second SLA from the configuration-change event.
 *
 * Requirements: 13.1, 13.4, 13.8
 */

export class ConfigChangeDto {
  /**
   * UUID of the authenticated user who initiated the change.
   * Required for all user-initiated configuration changes.
   */
  userId!: string;

  /**
   * Name of the configuration field that was changed.
   * Examples: "default_risk_percentage", "max_daily_loss_percentage",
   *           "strategy.A.min_rr_ratio".
   */
  fieldName!: string;

  /**
   * Value of the field before the change.
   * Encrypted at rest by the AuditLogs entity transformer.
   */
  previousValue!: string;

  /**
   * Value of the field after the change.
   * Encrypted at rest by the AuditLogs entity transformer.
   */
  newValue!: string;

  /**
   * Entity type that owns the changed field.
   * Examples: "UserSettings", "Strategy", "SystemConfig".
   */
  entityType!: string;

  /**
   * UUID of the specific entity row that was modified.
   */
  entityId!: string;

  /**
   * IP address of the client that submitted the change request.
   * NULL for system-originated changes.
   */
  ipAddress?: string | null;
}
