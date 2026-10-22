/**
 * The ref-space allocation lives in `src/shared/cloud/ref-space.ts`.
 *
 * It is shared code (it depends only on `SHARDING`), and the Worker's coordinator
 * needs it to fan out partition merges — while the Worker deliberately never imports
 * from `tools/`. This module re-exports it so the indexer's existing imports keep
 * working unchanged.
 */

export * from "../../../src/shared/cloud/ref-space";
