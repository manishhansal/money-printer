/**
 * LoginDto — request body for POST /auth/login.
 *
 * The Extension authenticates with the CloudEngine using the Dhan
 * `clientId` (Dhan account identifier) and the `apiKey` stored in
 * `BrokerAccounts`.  Credentials are validated server-side; no plaintext
 * credential is ever returned in the response.
 *
 * Requirements: 1.7, 16.9
 */

import { IsNotEmpty, IsString } from 'class-validator';

export class LoginDto {
  /**
   * Dhan-assigned client / account identifier.
   * Matched against `BrokerAccounts.clientId`.
   */
  @IsString()
  @IsNotEmpty()
  clientId!: string;

  /**
   * Dhan API key associated with the account.
   * Compared (in plaintext after decryption) with `BrokerAccounts.apiKey`.
   */
  @IsString()
  @IsNotEmpty()
  apiKey!: string;
}
