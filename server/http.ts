import type { IncomingHttpHeaders } from "node:http";

export type ApiRequest = {
  method?: string;
  body?: unknown;
  headers: IncomingHttpHeaders;
};

export type ApiResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): ApiResponse;
  json(body: unknown): unknown;
};
