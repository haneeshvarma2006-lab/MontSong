import { z } from 'zod';

import { badRequest, validationFailed } from '../errors';

/**
 * Turn a zod failure into an AppError carrying per-field messages, so a form
 * can highlight the offending input instead of showing one generic banner.
 */
export function parseOrThrow<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): z.infer<Schema> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  const details: Record<string, string[]> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_';
    (details[key] ??= []).push(issue.message);
  }

  const firstMessage = result.error.issues[0]?.message ?? 'Some of those values were not valid.';
  throw validationFailed(firstMessage, { details });
}

/** Read and validate a JSON body, refusing anything that is not an object. */
export async function parseJsonBody<Schema extends z.ZodType>(
  request: Request,
  schema: Schema,
): Promise<z.infer<Schema>> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw badRequest('Expected a JSON request body.');
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw badRequest('The request body was not valid JSON.');
  }

  return parseOrThrow(schema, raw);
}

/** Validate a URLSearchParams-derived query object. */
export function parseSearchParams<Schema extends z.ZodType>(
  params: URLSearchParams,
  schema: Schema,
): z.infer<Schema> {
  const object: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    if (value !== '') object[key] = value;
  }
  return parseOrThrow(schema, object);
}
