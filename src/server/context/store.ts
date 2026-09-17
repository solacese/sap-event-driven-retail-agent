// ---------------------------------------------------------------------------
// ContextStore: the materialised view built from subscribed event streams.
// When a signal is already here, the agent labels it CACHED ("already knew").
// When it is not, the agent issues a mesh request and labels it REQUESTED.
// This CACHED vs REQUESTED distinction is the single strongest EDA talking point.
// ---------------------------------------------------------------------------
import type {
  PriceUpdated,
  WeatherReply,
  NewsReply,
  InventoryReply,
  CustomerInterestReply,
} from '../agent/schema.js';

export interface ConsentRecord {
  customerId: string;
  sku?: string;
  consented: boolean;
}

export class ContextStore {
  // Latest weather forecast per country (from weather/forecast/updated stream).
  private weather = new Map<string, WeatherReply>();
  // Latest national-event flag per country (from news stream).
  private news = new Map<string, NewsReply>();
  // Stock per storeId:sku (from inventory stock-level stream).
  private stock = new Map<string, { storeId: string; sku: string; units: number; city: string; daysOfCover: number }>();
  // Consent per customerId (from consent stream).
  private consent = new Map<string, boolean>();
  // Latest price update per sku (the triggers).
  private prices = new Map<string, PriceUpdated>();

  setWeather(country: string, w: WeatherReply) {
    this.weather.set(country, w);
  }
  getWeather(country: string): WeatherReply | undefined {
    return this.weather.get(country);
  }

  setNews(country: string, n: NewsReply) {
    this.news.set(country, n);
  }
  getNews(country: string): NewsReply | undefined {
    return this.news.get(country);
  }

  setStock(rec: { storeId: string; sku: string; units: number; city: string; daysOfCover: number }) {
    this.stock.set(`${rec.storeId}:${rec.sku}`, rec);
  }
  getStockForSku(sku: string) {
    return [...this.stock.values()].filter((s) => s.sku === sku);
  }

  setConsent(customerId: string, consented: boolean) {
    this.consent.set(customerId, consented);
  }
  consentedCount(): number {
    return [...this.consent.values()].filter(Boolean).length;
  }
  hasConsentData(): boolean {
    return this.consent.size > 0;
  }

  setPrice(p: PriceUpdated) {
    this.prices.set(p.sku, p);
  }
  getPrice(sku: string): PriceUpdated | undefined {
    return this.prices.get(sku);
  }

  hasWeather(country: string): boolean {
    return this.weather.has(country);
  }
  hasNews(country: string): boolean {
    return this.news.has(country);
  }
  hasStock(sku: string): boolean {
    return this.getStockForSku(sku).length > 0;
  }

  reset() {
    this.weather.clear();
    this.news.clear();
    this.stock.clear();
    this.consent.clear();
    this.prices.clear();
  }

  snapshot() {
    return {
      weatherCountries: [...this.weather.keys()],
      newsCountries: [...this.news.keys()],
      stockEntries: this.stock.size,
      consentRecords: this.consent.size,
      consentedCount: this.consentedCount(),
      prices: [...this.prices.keys()],
    };
  }
}

export const contextStore = new ContextStore();

// Re-export reply types used by consumers building tool replies from the store.
export type { WeatherReply, NewsReply, InventoryReply, CustomerInterestReply };
