/*
 * Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
 */

/**
 * Transport limits for local attachments.
 *
 * The current user message is kept verbatim during compaction, so an unbounded
 * attachment cannot be recovered from once it exceeds the provider budget.
 * These values mirror the limits Pi, OpenCode and T3 Code apply before a
 * request: images are resized/recompressed, text is windowed, and everything
 * that cannot be represented cheaply is referenced by its local path.
 */
export const MAX_INLINE_IMAGE_EDGE = 2000;
export const MAX_INLINE_IMAGE_BASE64_CHARS = 4_500_000;
export const MAX_IMAGE_SOURCE_BYTES = 50 * 1024 * 1024;

/** One attachment never sends more text than a single bounded Read window. */
export const MAX_INLINE_TEXT_CHARS = 50_000;
/** All inline tool-result text parts in one message share this budget. */
export const MAX_INLINE_TEXT_TOTAL_CHARS = 100_000;
export const MAX_INLINE_TEXT_READ_BYTES = 200 * 1024;

export const MAX_INLINE_PDF_BYTES = 8 * 1024 * 1024;
export const MAX_INLINE_PDF_BASE64_CHARS = 12 * 1024 * 1024;
/** Inline tool-result PDFs in one message share this budget. */
export const MAX_INLINE_PDF_TOTAL_BASE64_CHARS = 24 * 1024 * 1024;

export const MAX_BINARY_SNIFF_BYTES = 8 * 1024;
