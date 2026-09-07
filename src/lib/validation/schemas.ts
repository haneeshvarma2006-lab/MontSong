import { z } from 'zod';

import { AUDIO_TYPES } from '../constants';

/**
 * Every value that crosses the API boundary is parsed here first.
 *
 * Two things this buys beyond type safety: strings are trimmed and length-capped
 * before they reach the database (so a 10 MB "title" is rejected, not stored),
 * and `.strict()` rejects unknown keys, so a request cannot smuggle
 * `downloadCount` or `isPublished` into an update that was not meant to accept
 * them — mass-assignment is refused rather than silently ignored.
 */

const trimmed = (max: number) => z.string().trim().max(max);

/** A short, human-entered line of text. */
const shortText = (max: number, label: string) =>
  trimmed(max).min(1, `${label} is required.`);

/**
 * A text field the user may leave blank — and may also blank out later.
 *
 * The distinction matters on a partial update, where `undefined` means "not
 * mentioned, leave it alone" and `null` means "clear it". Mapping an empty
 * string to `undefined` collapses the two, so emptying Artist or Description
 * in the admin form reported success and silently changed nothing: every
 * partial-update repository skips `undefined` keys by design. Empty means
 * cleared, so it maps to `null`.
 */
const optionalText = (max: number) =>
  trimmed(max)
    .nullable()
    .optional()
    .transform((value) => (value === '' ? null : value));

/**
 * Slugs are lowercase, hyphen-separated, and never start or end with a hyphen.
 * They appear directly in public URLs, so the character set stays conservative.
 */
export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(80)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Use lowercase letters, numbers and single hyphens (for example "tamil-ogs").',
  );

export const idSchema = z.string().trim().min(1).max(64);

/** Accent colours are written straight into a CSS custom property. */
export const hexColorSchema = z
  .string()
  .trim()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Use a hex colour such as #e0523f.');

/**
 * A single emoji or short glyph. Capped tightly: this is rendered as-is, and
 * an unbounded string here would be a layout weapon even after escaping.
 */
export const iconSchema = trimmed(8);

// --- Auth -------------------------------------------------------------------

export const loginSchema = z
  .object({
    username: shortText(120, 'Username'),
    password: z.string().min(1, 'Password is required.').max(400),
  })
  .strict();

// --- Categories -------------------------------------------------------------

export const createCategorySchema = z
  .object({
    name: shortText(80, 'Name'),
    slug: slugSchema.optional(),
    description: optionalText(400),
    icon: iconSchema.optional(),
    accent: hexColorSchema.optional(),
    isPublished: z.boolean().default(true),
    isFeatured: z.boolean().default(false),
  })
  .strict();

export const updateCategorySchema = createCategorySchema.partial().strict();

export const reorderSchema = z
  .object({
    /** Ids in their new order, first to last. */
    ids: z.array(idSchema).min(1).max(500),
  })
  .strict();

// --- Audio ------------------------------------------------------------------

const tagsSchema = z
  .array(trimmed(40).min(1))
  .max(12, 'Twelve tags is plenty.')
  .optional();

export const audioMetadataSchema = z
  .object({
    title: shortText(160, 'Title'),
    artist: optionalText(120),
    type: z.enum(AUDIO_TYPES).default('song'),
    description: optionalText(2000),
    categoryId: idSchema.optional().nullable(),
    tags: tagsSchema,
    isPublished: z.boolean().default(true),
    isFeatured: z.boolean().default(false),
    slug: slugSchema.optional(),
    /**
     * Duration in seconds, measured in the browser before upload. Telegram
     * reports it for MP3/M4A but not for documents, so the client supplies it
     * for every format. Bounded so a bad value cannot produce a nonsense UI.
     */
    durationSec: z.coerce.number().int().min(0).max(24 * 60 * 60).optional(),
  })
  .strict();

export const updateAudioSchema = audioMetadataSchema
  .omit({ durationSec: true })
  .partial()
  .strict();

export const moveAudioSchema = z
  .object({
    categoryId: idSchema.nullable(),
  })
  .strict();

// --- Public queries ---------------------------------------------------------

export const searchQuerySchema = z
  .object({
    q: trimmed(120).optional(),
    category: slugSchema.optional(),
    type: z.enum(AUDIO_TYPES).optional(),
    limit: z.coerce.number().int().min(1).max(60).default(24),
    cursor: z.string().trim().max(64).optional(),
  })
  .strict();

export const adminAudioQuerySchema = z
  .object({
    q: trimmed(120).optional(),
    categoryId: idSchema.optional(),
    type: z.enum(AUDIO_TYPES).optional(),
    status: z.enum(['all', 'published', 'unpublished']).default('all'),
    sort: z.enum(['recent', 'title', 'downloads', 'order']).default('recent'),
    page: z.coerce.number().int().min(1).max(1000).default(1),
    perPage: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

// --- Site settings ----------------------------------------------------------

export const siteSettingsSchema = z
  .object({
    tagline: optionalText(160),
    about: optionalText(600),
  })
  .strict();

export type LoginInput = z.infer<typeof loginSchema>;
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type AudioMetadataInput = z.infer<typeof audioMetadataSchema>;
export type UpdateAudioInput = z.infer<typeof updateAudioSchema>;
export type SearchQueryInput = z.infer<typeof searchQuerySchema>;
export type AdminAudioQueryInput = z.infer<typeof adminAudioQuerySchema>;
