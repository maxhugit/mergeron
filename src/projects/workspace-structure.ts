/** Stable names shared by workspace creation, file guards and project modules. */
import * as path from 'node:path';
export const WORKSPACE_LAYOUT_VERSION = 3;
export const PROJECT_SYSTEM_SPACES_DIRECTORY = '.mergeron-system';
export const PROJECT_DRAFT_SPACES_DIRECTORY = '.mergeron-agent-drafts';
/** A sibling, not a child of the agent's working directory. */
export function projectSystemPath(
  root: string,
  version = WORKSPACE_LAYOUT_VERSION,
) {
  return version >= 3
    ? path.join(
        path.dirname(root),
        PROJECT_SYSTEM_SPACES_DIRECTORY,
        path.basename(root),
      )
    : path.join(root, PROJECT_SYSTEM_DIRECTORY);
}
export function projectDraftPath(root: string) {
  return path.join(
    path.dirname(root),
    PROJECT_DRAFT_SPACES_DIRECTORY,
    path.basename(root),
  );
}
export function isPrivateProjectSpace(value: string) {
  return value
    .split(path.sep)
    .some(
      (part) =>
        part === PROJECT_SYSTEM_SPACES_DIRECTORY ||
        part === PROJECT_DRAFT_SPACES_DIRECTORY,
    );
}
export const PROJECT_SYSTEM_DIRECTORY = '.mergeron';
export const LEGACY_PROJECT_SYSTEM_DIRECTORY = '.webui';
export const PROJECT_CONTENT_DIRECTORIES = [
  'documents',
  'sources',
  'livrables',
] as const;

export const EMBEDDED_PROJECT_WORKSPACE_INSTRUCTIONS =
  '# Organisation du projet\n\nLes fichiers réservés à Mergeron sont dans `.mergeron/`. Les documents de travail peuvent être rangés dans `documents/`, `sources/` et `livrables/`.\n\nLes instructions, connaissances et décisions partagées sont gérées depuis l’onglet Connaissances du projet et stockées dans `.mergeron/knowledge/`. Mergeron les fournit aux conversations à chaque nouvel échange.\n';

export const PROJECT_WORKSPACE_INSTRUCTIONS =
  '# Organisation du projet\n\nCet espace de travail contient les documents, sources et livrables du projet, dans `documents/`, `sources/` et `livrables/`. Les données internes, connaissances et historiques sont conservés dans un espace système séparé réservé aux administrateurs, et ne doivent pas être modifiés directement.\n\nLes instructions, connaissances et décisions partagées sont gérées depuis l’onglet Connaissances du projet. Mergeron les fournit aux conversations à chaque nouvel échange.\n';

/** Only this exact generated text may be replaced during migration. */
export const LEGACY_PROJECT_WORKSPACE_INSTRUCTIONS =
  '# Organisation du projet\n\nLes fichiers réservés à WebUI sont dans `.webui/`. Les documents de travail peuvent être rangés dans `documents/`, `sources/` et `livrables/`.\n\nLes instructions, connaissances et décisions partagées sont gérées depuis l’onglet Connaissances du projet et stockées dans `.webui/knowledge/`. WebUI les fournit aux conversations à chaque nouvel échange.\n';
