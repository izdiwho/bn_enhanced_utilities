export interface Meter {
  meterNo: string;
  meterType: "electricity" | "water";
  status: string;
  fullName: string;
  address: string;
  kampong: string;
  mukim: string;
  district: string;
  postcode: string;
  remainingUnit: number;
  remainingUnitLabel: string; // "kWh" | "m³"
  remainingBalance: number;   // BND
  lastUpdated: string;        // ISO
  reportParam: string;
  reportParamTransaction: string;
}

export interface ConsumptionRecord {
  period: string;             // "YYYY-MM-DD" (daily)
  consumption: number;        // kWh or m³
  estimatedCost?: number;
}

export interface WeatherData {
  dates: string[];         // "YYYY-MM-DD"
  feelsLikeHigh: number[]; // °C
  feelsLikeLow: number[];  // °C
}

export interface TopUpRecord {
  topupDate: string;          // ISO
  transactionNo: string;
  meterNo: string;
  topupAmount: number;
  initialLoanDebtCleared: number;
  actualRechargeAmount: number;
  unitsCredited: number;
  paymentMode: string;
  siteName: string;
  source: string;
}

export interface AccountResponse {
  meters: Meter[];
  fromCache: boolean;
}

export interface ConsumptionHistoryResponse {
  records: ConsumptionRecord[];
  warning?: string;
  fromCache: boolean;
}

export interface TopUpHistoryResponse {
  records: TopUpRecord[];
  warning?: string;
  fromCache: boolean;
}

export interface ApiError {
  error: string;
}

export interface LastScrapeInfo {
  at: number;
  status: "success" | "error";
  trigger: "schedule" | "manual" | "startup";
}

export interface ConfigResponse {
  meters: Meter[];
  features: {
    ai: boolean;
  };
  lastScrape?: LastScrapeInfo | null;
}
