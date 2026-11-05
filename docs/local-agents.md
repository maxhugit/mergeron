# Agents locaux avec Ollama

Un administrateur peut créer un agent dont le modèle s’exécute sur un serveur
Ollama privé. Le runtime Codex conserve l’exécution des outils et la conversation ;
Ollama effectue l’inférence. Aucun compte OpenAI n’est nécessaire pour cet agent.
Le choix est fixé à la création : un historique existant n’est pas transféré.

## Préparer Ollama

Ollama est un service installé et administré séparément. Cette fonctionnalité
n’installe pas de conteneur et ne télécharge pas de modèle. Installer d’abord
un modèle compatible avec les outils, par exemple `gpt-oss:20b`, puis créer une
variante dont le contexte correspond à celui configuré dans Mergeron :

```sh
ollama pull gpt-oss:20b
```

Créer un fichier `Modelfile` :

```text
FROM gpt-oss:20b
PARAMETER num_ctx 16384
PARAMETER num_predict 2048
PARAMETER temperature 0
```

```sh
ollama create gpt-oss:local -f Modelfile
```

Pour désactiver les fonctionnalités cloud d’Ollama, son opérateur peut configurer
`OLLAMA_NO_CLOUD=1`, puis redémarrer **Ollama**. Ce réglage appartient au service
Ollama, pas au conteneur Mergeron. Voir la [documentation Ollama](https://docs.ollama.com/faq#how-do-i-disable-ollamas-cloud-features).

## Configurer et créer un agent

Dans **Paramètres → Codex → Agents locaux · Ollama**, renseigner :

| Réglage                   | Fonction                                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Activer les agents locaux | Autorise leur création et leur exécution. Désactiver bloque les prochains envois.                                                                                                                       |
| URL privée d’Ollama       | Adresse HTTP(S) joignable depuis le conteneur applicatif, par exemple `http://192.168.1.10:11434`. Accepte une IPv4 privée, une boucle locale ou `localhost`, sans identifiants, chemin ni redirection. |
| Modèles autorisés         | Noms exacts séparés par des virgules, par exemple `gpt-oss:local`. Ils doivent être installés, locaux et compatibles avec les outils. Les modèles cloud et les modèles d’embedding sont refusés.        |
| Fenêtre de contexte       | Budget déclaré au runtime, de 8 192 à 131 072 tokens. Il doit correspondre au `num_ctx` réellement configuré dans Ollama. Défaut : 16 384.                                                              |

Enregistrer puis **Vérifier la configuration enregistrée**. Dans le menu **+**
du projet, choisir **Créer un agent local**, sélectionner son dossier de travail
et son modèle. Le modèle apparaît comme **Ollama · nom du modèle** dans la barre
de saisie. Les administrateurs peuvent choisir un autre modèle local autorisé
pour cet agent. Pour utiliser le cloud, créer un autre agent.

`localhost` désigne le conteneur applicatif lui-même : utiliser une adresse
privée joignable si Ollama tourne dans un autre conteneur ou sur une autre machine.
Mergeron ne modifie pas les règles du proxy, les réseaux Docker ou le pare-feu.
Garder Ollama sur un réseau privé contrôlé ; ne pas publier son API sur Internet.

## Comportement et limites

- Les reprises, duplications, revues et changements de mode conservent le
  fournisseur local. Une panne, un modèle absent, une configuration perdue ou
  désactivée produit une erreur, sans repli vers OpenAI. Un changement d’URL
  exige de créer un autre agent ; il ne redirige pas silencieusement les anciens.
- Une passerelle sur la boucle locale transmet les requêtes Responses vers
  Ollama, sans jeton OpenAI ni cookie. Elle borne la taille et la durée des requêtes,
  refuse les redirections et vérifie le modèle avant chaque requête.
- La recherche web du modèle et les plugins Codex sont désactivés dans cette
  configuration, ainsi que les applications Codex. Les travaux structurés demandés via le MCP interne héritent
  du modèle local. L’étiquetage IA automatique d’un document enregistré par cet
  agent est suspendu, car sa tâche différée utilise normalement le défaut du projet.
- **Inférence locale ne signifie pas isolement réseau complet.** Le terminal,
  les serveurs MCP, le navigateur, les intégrations et les fichiers partagés
  gardent leurs permissions. Les actions IA lancées séparément par une personne
  suivent leur configuration propre. Ne pas présenter ce mode comme une garantie
  qu’aucune donnée ne quitte le serveur ; une politique hors ligne complète exige
  aussi le contrôle des outils et des sorties réseau.
- Les performances et la qualité dépendent du modèle et du matériel. Le premier
  chargement peut être lent. Tester les opérations attendues avant de confier une
  tâche importante à un modèle local.

La configuration et les associations agent/fournisseur sont conservées dans
SQLite. Aucun poids de modèle ni secret n’est ajouté au dépôt. Le test natif
`src/local-agents/local-agents.native.spec.ts` vérifie deux tours réels contre un
fournisseur local synthétique, avec redémarrage du runtime et duplication.

## Métadonnées des modèles locaux

Au démarrage de Codex, Mergeron complète le catalogue effectif avec les noms
exacts des modèles Ollama autorisés. Cela évite l’avertissement « Model metadata
not found » et fournit au moteur la fenêtre de contexte configurée. Celle-ci
doit toujours correspondre à la capacité réellement configurée dans Ollama.
Les entrées locales générées déclarent uniquement du texte et des capacités
prudentes ; elles n’activent ni recherche web, ni macros, ni permissions
supplémentaires. Une entrée exacte déjà définie par l’administrateur est conservée.

Après une modification de l’activation, des modèles ou du contexte, les paramètres
affichent **Redémarrer Codex**. Ce redémarrage reste explicite et utilise les
protections existantes : il est refusé si des agents travaillent ou si des
approbations sont en attente. Les nouveaux envois locaux sont bloqués jusqu’au
chargement des métadonnées actualisées, sans repli vers un autre fournisseur.

Techniquement, un catalogue dérivé `runtime-local-<sha256>.json` est écrit dans
`CODEX_HOME/webui/model-catalog` puis transmis à l’app-server avec
`model_catalog_json` au démarrage. Les fichiers du catalogue administrateur,
leurs entrées cloud et le pointeur enregistré dans `config.toml` ne sont pas
modifiés. Le contrôle des catalogues continue de suivre la source originale,
avec ses versions et ses protections contre les modifications concurrentes.
Les fichiers dérivés ne contiennent aucun secret et ne sont pas supprimés pendant
qu’un processus peut encore les utiliser.

Les tests natifs couvrent le nom `gpt-oss:mergeron-dev-20b`, deux tours d’inférence,
la reprise après redémarrage, la duplication et l’absence de l’avertissement.
Les tests de catalogue couvrent aussi l’activation d’un autre catalogue et le
retour au catalogue par défaut avec les modèles locaux activés.
