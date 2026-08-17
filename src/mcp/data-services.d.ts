// Declaraciones de tipo para data-services.js (puente a la lógica real en JS).

export interface BalanceResult {
  ok: boolean;
  error?: string;
  total?: number;
  accounts?: Array<{ id: string; name: string; type: string; currency: string; balance: number }>;
  account?: { id: string; name: string; type: string; currency: string; balance: number };
}

export interface WriteResult {
  ok: boolean;
  error?: string;
  transactionId?: string;
  balance?: number;
  transferId?: string;
  fromBalance?: number;
  toBalance?: number;
}

export interface ReceiptResult {
  ok: boolean;
  error?: string;
  merchant?: string;
  total?: number;
  date?: string | null;
  items?: Array<{ name: string; amount: number; category: string; subcategory: string | null }>;
  groups?: Array<{ category: string; subcategory: string | null; total: number; count: number }>;
}

export interface TransferParseResult {
  ok: boolean;
  error?: string;
  amount?: number | null;
  from?: string | null;
  to?: string | null;
  fromHint?: string | null;
  toHint?: string | null;
  confident?: boolean;
}

export interface DriveResult {
  ok: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

export declare function getBalance(params: { syncCode: string; accountId?: string }): Promise<BalanceResult>;
export declare function addTransaction(params: {
  syncCode: string;
  accountId: string;
  amount: number;
  description: string;
  category?: string;
  date?: string;
}): Promise<WriteResult>;
export declare function transferFunds(params: {
  syncCode: string;
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  notes?: string;
}): Promise<WriteResult>;
export declare function scanReceipt(params: {
  text?: string;
  imageBase64?: string;
  categories?: Array<{ name: string }>;
  categoryAliases?: Record<string, string>;
}): Promise<ReceiptResult>;
export declare function scanTransfer(params: {
  text: string;
  accounts?: Array<{ id: string; name: string; currency?: string }>;
  transferAliases?: Record<string, string>;
}): Promise<TransferParseResult>;
export declare function driveStatus(): Promise<DriveResult>;
export declare function driveSync(): Promise<DriveResult>;
export declare function drivePending(): Promise<DriveResult>;
