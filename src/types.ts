// types.ts — Definiciones de tipos del dominio Mis Finanzas

// ---------- Monedas y FX ----------

export type Currency = "EUR" | "USD" | "GBP" | "MXN" | "BTC" | "ETH";

export type FXRates = Record<Currency, number>;

export interface PriceHistory {
  BTC: number[];
  ETH: number[];
  GOLD: number[];
}

// ---------- Cuentas ----------

export type AccountType =
  | "checking"
  | "savings"
  | "deposit"
  | "investment"
  | "sofipo"
  | "credit"
  | "auto_loan";

export type AccrualFrequency = "none" | "daily" | "monthly";

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  currency: Currency;
  balance: number;
  rate: number;
  accrual: AccrualFrequency;
  lastAccrual: string; // ISO date (YYYY-MM-DD)
  // Cuentas con tope escalonado
  capped?: boolean;
  rate1?: number;
  accrual1?: AccrualFrequency;
  balanceCap1?: number;
  gainCap1?: number;
  gainAccrued1?: number;
  lastAccrual1?: string;
  rate2?: number;
  accrual2?: AccrualFrequency;
  balanceCap2?: number;
  gainCap2?: number;
  gainAccrued2?: number;
  lastAccrual2?: string;
  // ISR configurable por cuenta
  isrRate?: number;
  // Reglas de depósito de intereses de fin de semana (configurable por banco/cuenta)
  weekendDepositDay?: 'saturday' | 'monday';
  weekendDeposits?: 1 | 2 | 3; // 1 = junto, 2 o 3 = depósitos separados el mismo día
  // Tarjetas de crédito
  payDay?: number;
  lastPaidCycle?: string;
  // Metadata
  _updatedAt?: number;
}

// ---------- Transacciones ----------

export interface Transaction {
  id: string;
  date: string; // ISO date
  description: string;
  amount: number;
  currency: Currency;
  category: string;
  accountId: string;
  auto?: boolean;
  counterpartId?: string;
  notes?: string; // motivo o descripción adicional de la transferencia
  _updatedAt?: number;
}

export interface ScheduledTransfer {
  id: string;
  _updatedAt?: number;
  [key: string]: unknown;
}

// ---------- Categorías ----------

export type CategoryType = "expense" | "income" | "system";

export interface Category {
  id: string;
  name: string;
  type: CategoryType;
  color: string;
  keywords: string[];
  subcategories: string[];
  system?: boolean;
}

// ---------- Activos ----------

export interface CryptoAsset {
  id: string;
  symbol: string;
  name: string;
  qty: number;
  costBasisEUR: number;
}

export interface GoldAsset {
  grams: number;
  costBasisEUR: number;
}

export interface RealEstateAsset {
  id: string;
  name: string;
  valueEUR: number;
  costBasisEUR: number;
  source: string;
  featured?: boolean;
  _updatedAt?: number;
}

export interface DepreciatingAsset {
  id: string;
  name: string;
  kind: string;
  valueEUR: number;
  costBasisEUR: number;
  depRate: number;
  _updatedAt?: number;
}

export interface Assets {
  crypto: CryptoAsset[];
  gold: GoldAsset;
  realEstate: RealEstateAsset[];
  depreciating: DepreciatingAsset[];
}

// ---------- Settings ----------

export interface Settings {
  baseCurrency: Currency;
  spendLimit: number;
  biometric: boolean;
  dashboardCards?: Record<string, boolean>;
}

// ---------- Aprendizaje ----------

export type TransferAliases = Record<string, string>;
export type CategoryAliases = Record<string, string>;

export interface StatementPattern {
  description?: string;
  category?: string;
  direction?: string;
  accountId?: string;
  appliedCount: number;
  learnedAt?: string;
  [key: string]: unknown;
}

export type StatementPatterns = Record<string, StatementPattern>;

// ---------- Estado global ----------

export interface AppState {
  settings: Settings;
  accounts: Account[];
  assets: Assets;
  transactions: Transaction[];
  scheduled: ScheduledTransfer[];
  categories: Category[];
  transferAliases: TransferAliases;
  categoryAliases: CategoryAliases;
  statementPatterns: StatementPatterns;
  fx: FXRates;
  priceHistory: PriceHistory;
  goldPriceEUR: number;
  _syncVersion: number;
  // Para que los deletes de transacciones no reaparezcan por merge de nube
  deletedTransactions?: Record<string, number>; // txId -> delete timestamp (ms)
  deletedAccountIds?: string[]; // IDs de cuentas explícitamente borradas por el usuario
}

// ---------- Acciones del reducer (discriminated union) ----------

export type Action =
  | { type: "hydrate"; state: AppState }
  | { type: "update_fx"; fx: FXRates; priceHistory?: Partial<PriceHistory> }
  | { type: "add_transaction"; tx: Partial<Transaction> & { description: string; amount: number; currency: Currency; accountId: string } }
  | { type: "update_transaction"; id: string; patch: Partial<Transaction> }
  | { type: "delete_transaction"; id: string }
  | { type: "transfer"; fromId: string; toId: string; amount: number; date?: string; notes?: string }
  | { type: "schedule_transfer"; item: Partial<ScheduledTransfer> }
  | { type: "set_limit"; amount: number }
  | { type: "set_base_currency"; currency: Currency }
  | { type: "update_settings"; patch: Partial<Settings> }
  | { type: "set_rate"; accountId: string; rate: number; accrual?: AccrualFrequency }
  | { type: "accrue" }
  | { type: "add_account"; account: Partial<Account> & { name: string; type: AccountType; currency: Currency; balance: number } }
  | { type: "update_account"; accountId: string; patch: Partial<Account> }
  | { type: "delete_account"; accountId: string }
  | { type: "add_category"; category: Partial<Category> & { name: string } }
  | { type: "update_category"; id: string; patch: Partial<Category> }
  | { type: "delete_category"; id: string }
  | { type: "update_gold"; patch: Partial<GoldAsset> }
  | { type: "add_crypto"; crypto: Partial<CryptoAsset> & { symbol: string; name: string } }
  | { type: "update_crypto"; id: string; patch: Partial<CryptoAsset> }
  | { type: "delete_crypto"; id: string }
  | { type: "add_realestate"; item: Partial<RealEstateAsset> & { name: string; valueEUR: number; costBasisEUR: number } }
  | { type: "update_realestate"; id: string; patch: Partial<RealEstateAsset> }
  | { type: "delete_realestate"; id: string }
  | { type: "set_featured_realestate"; id: string }
  | { type: "add_depreciating"; item: Partial<DepreciatingAsset> & { name: string; valueEUR: number; costBasisEUR: number } }
  | { type: "update_depreciating"; id: string; patch: Partial<DepreciatingAsset> }
  | { type: "delete_depreciating"; id: string }
  | { type: "mark_card_paid"; accountId: string; cycle: string }
  | { type: "learn_transfer_aliases"; aliases: Record<string, string> }
  | { type: "learn_category_aliases"; aliases: Record<string, string> }
  | { type: "learn_statement_pattern"; key: string; pattern: Partial<StatementPattern> }
  | { type: "restore"; state: Partial<AppState> }
  | { type: "reset" };

// ---------- Selectores ----------

export interface NetWorth {
  cash: number;
  crypto: number;
  gold: number;
  realEstate: number;
  depreciating: number;
  autoLoan: number;
  total: number;
}

export interface PendingCardPayment {
  account: Account;
  cycle: string;
  paid: boolean;
  due: boolean;
  daysToDue: number;
  debt: number;
}

// ---------- Intents (parser NL) ----------

export interface ParsedIntent {
  type: "expense" | "income" | "transfer" | "schedule_transfer" | "set_limit";
  amount: number;
  currency: Currency;
  description?: string;
  category?: string;
  fromName?: string | null;
  toName?: string | null;
  scheduled?: boolean;
  summary: string;
}
