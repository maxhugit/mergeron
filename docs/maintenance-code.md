# Maintenance du code

Le nettoyage du dépôt retire les chemins d’exécution abandonnés et les
dépendances sans consommateur. Il conserve les contrats utilisés par les
installations existantes et remplace les fixtures périmées par des tests des
parcours réellement accessibles.

## Éléments retirés

Les références d’import TypeScript, les entrées du routeur et les usages dans
les scripts ont été vérifiés pour les éléments suivants :

- l’ancien point d’entrée vide `web/src/App.tsx` et la page `routes/chat-view.tsx`,
  remplacés par le routeur et les pages actuels ;
- les composants inutilisés `DirectoryPickerDialog`, `ToolCallGroup`,
  `TerminalView` et les panneaux redimensionnables abandonnés ;
- l’ancien adaptateur `web/src/lib/settings-api.ts`, le type `GlobalView` et
  l’enveloppe `isHumanServerRequest`, sans consommateur ;
- `ManageWorkspacesDialog`, qui ne servait plus que dans une fixture navigateur.

La dépendance `react-resizable-panels` est retirée avec son unique composant
consommateur, lui-même inutilisé. Le lockfile est actualisé sans faire évoluer
les autres versions. Ce code était déjà absent des parcours applicatifs : son
retrait simplifie la maintenance et l’installation, sans promettre une baisse
du JavaScript téléchargé par l’utilisateur.

Le test des emplacements du projet utilise désormais `ProjectSettingsPanel`,
comme l’application. Il conserve les contrôles ordinateur/mobile, la distinction
des connexions et l’ouverture du parcours d’ajout. Le modèle de configuration
des sondes est renommé `config.toml.example` pour corriger sa faute de nommage.

## Lectures et chargements évités

Les tâches du contexte et des outils projet sont lues par lots de 500
gestionnaires autorisés, plutôt que par une requête par gestionnaire. Cette
borne reste compatible avec les constructions SQLite limitées à 999 paramètres.
L’ordre reste celui du gestionnaire puis de la tâche, avec les mêmes filtres
d’accès et la même pagination métier.

| Cas synthétique             | Anciennes requêtes de lecture des tâches | Requêtes regroupées |
| --------------------------- | ---------------------------------------- | ------------------- |
| 13 gestionnaires autorisés  | 13                                       | 1                   |
| 502 gestionnaires autorisés | 502                                      | 2                   |

Ces nombres mesurent les requêtes de la fixture, pas une durée de réponse en
production. Pour le contexte d’une conversation, le filtre sur l’agent est
appliqué dans la requête et chaque lot est limité à dix tâches liées, avant la
limite globale de dix éléments injectés. Le contexte ne charge plus toutes les
tâches non liées pour les écarter ensuite.

Les paramètres du projet ne demandent le catalogue des modèles que dans la
section **Agents**, comme les intégrations. Ouvrir **Emplacements** ou
**Navigateur** ne dépend donc pas d’un chargement inutile du moteur.

## Éléments à conserver

- Une migration ancienne reste indispensable pour les anciennes installations.
- Les adaptations de versions et restaurations restent nécessaires tant que
  les données correspondantes sont prises en charge.
- Les correctifs et déclarations de sécurité sont liés aux composants construits.
- Les sondes de `codex_probe/` mesurent des comportements natifs ; elles ne sont
  pas remplaçables par des mocks prétendant vérifier le moteur réel.
- Le cas manuel `web/tests/gantt-zoom.html` possède une entrée HTML explicite et
  reste un contrôle de zoom et de redimensionnement, hors suite Vitest.
- Les clients et schémas générés ne sont pas nettoyés à la main sur la seule base
  d’exports qui paraissent inutilisés.

L’absence d’import ne suffit pas à déclarer un fichier inutile : vérifier aussi
les chargements différés, les entrées HTML, Docker, CI et les commandes autonomes.
La cartographie des [répertoires racine](../README.md#répertoires-du-dépôt) et le
test de documentation évitent qu’un nouveau dossier reste sans explication.
