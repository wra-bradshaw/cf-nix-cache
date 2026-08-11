import { expect } from 'vitest';
import { type TestHarness } from 'wrangler';

export type HarnessResponse = Awaited<ReturnType<TestHarness['fetch']>>;
export type JsonRequestOptions = NonNullable<
  Parameters<TestHarness['fetch']>[1]
>;

export async function request(
  server: TestHarness,
  base: string,
  pathName: string,
  init: JsonRequestOptions = {},
): Promise<HarnessResponse> {
  return server.fetch(`${base}${pathName}`, init);
}

export async function jsonRequest<T>(
  server: TestHarness,
  base: string,
  pathName: string,
  init: JsonRequestOptions = {},
): Promise<{ readonly response: HarnessResponse; readonly body: T }> {
  const response = await request(server, base, pathName, init);
  const text = await response.text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    body = text as T;
  }
  return { response, body };
}

export async function expectJson<T>(
  server: TestHarness,
  base: string,
  pathName: string,
  expectedStatus: number,
  init: JsonRequestOptions = {},
): Promise<T> {
  const result = await jsonRequest<T>(server, base, pathName, init);
  expect(
    result.response.status,
    `${init.method ?? 'GET'} ${pathName}: ${JSON.stringify(result.body)}`,
  ).toBe(expectedStatus);
  return result.body;
}
