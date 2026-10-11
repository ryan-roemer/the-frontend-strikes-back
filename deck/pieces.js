/**
 * The browser AI pieces: the tiles on "The available pieces" slide, and the
 * strip on each demo slide that shows which of them that demo uses.
 *
 * One list so the two cannot drift: rename a piece or change whether it is
 * `ready` here, and both slides change with it. Which demo uses which piece is
 * `DEMO_PIECES` in `demos.js`.
 *
 * `ready` means "here now"; without it the piece is emerging.
 */
export const PIECES = [
  { id: "embeddings", icon: "vector-three", title: "Embeddings", ready: true },
  { id: "vector-db", icon: "database", title: "Vector database", ready: true },
  { id: "classifiers", icon: "tag", title: "Classifiers", ready: true },
  { id: "deciders", icon: "signpost", title: "Deciders" },
  { id: "tools", icon: "wrench", title: "Tools" },
  { id: "language-models", icon: "brain", title: "Language models" },
  { id: "fine-tuned-models", icon: "target", title: "Fine-tuned models" },
];
