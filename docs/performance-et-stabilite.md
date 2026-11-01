# Performance et stabilité du code

L’audit porte sur les lectures du backend, les mises à jour de l’interface et la
validation CI/CD. Les corrections évitent des requêtes et des rendus inutiles,
réduisent les parcours quadratiques et renforcent la découverte des tests.
Elles ne changent ni les autorisations ni la politique de déploiement.

## Tableau de bord du backend

`ProjectsService.dashboard()` indexe les ressources accessibles une seule fois
par requête. Il ne relit plus la table des ressources pour chaque tâche. Pour
deux projets contenant chacun 1 000 tâches, la fixture de comptage passe de
2 006 à 6 lectures des données métier, hors requêtes propres au contrôle d’identité.
Les droits sont évalués dans la requête courante, sans cache partagé entre
utilisateurs. Un test avec le vrai service d’identité change puis révoque la
participation au projet, y compris pendant l’attente des métadonnées.

`summarizeProjects()` regroupe les données une fois par projet ou par ressource.
Les recherches d’enfants et d’alertes utilisent des ensembles plutôt que des
balayages imbriqués. L’ordre des alertes ex æquo, les statuts finaux personnalisés,
les tâches annulées et les estimations des feuilles sont conservés. Le maximum
d’activité est calculé sans passer tous les événements comme arguments à
`Math.max`, ce qui évite une erreur de pile sur de longues listes.

Mesure synthétique sur macOS ARM64 avec Node 24.19.0, comparaison au commit
`5054868`, neuf échantillons après un échauffement. Les résultats métier sont
comparés intégralement avant de chronométrer.

| Projets | Tâches | Médiane avant | Médiane après |
| ------- | ------ | ------------- | ------------- |
| 5       | 1 000  | 1,756 ms      | 0,738 ms      |
| 5       | 10 000 | 59,003 ms     | 5,581 ms      |
| 100     | 10 000 | 19,567 ms     | 4,242 ms      |

Il s’agit du calcul en mémoire, pas du temps d’une requête HTTP sur Unraid.
Pour reproduire avec un historique Git contenant ce commit et Node 22.23 ou
plus récent :

```bash
node scripts/benchmark-project-dashboard.mjs 5054868
```

Les tests vérifient aussi une liste de 150 000 événements d’activité. Les tests
de performance protègent les nombres de requêtes et les résultats, sans imposer
un seuil de durée dépendant de la machine CI.

## Navigation et flux de texte du frontend

La barre latérale ne s’abonne plus aux transcriptions complètes. Un sélecteur
par instance expose uniquement l’activité utile aux badges : traitement en cours,
attente d’approbation, attente de réponse et nombre d’approbations. Sa valeur reste
identique lorsqu’un fragment de texte ou une consommation de jetons arrive.
Les compteurs d’approbations sont mémorisés par objet immuable dans une `WeakMap`,
sans retenir les anciennes conversations.

Pour 100 fragments de plan reçus dans l’agent sélectionné ou en arrière-plan,
l’ancien abonnement provoque 100 nouveaux rendus du hook ; le nouveau n’en
provoque aucun. Un changement d’activité provoque toujours immédiatement le
rendu attendu. La suppression d’un agent retire son entrée. Le test du composant
conserve aussi le cas d’un ancien état actif qui ne doit plus remplacer l’état
du serveur après désabonnement.

Les vues d’agents restent limitées à cinq vues retenues par le mécanisme
existant. Les imports différés des éditeurs et des vues spécialisées, la
virtualisation du transcript, le regroupement des invalidations et la pause des
surfaces cachées sont conservés. Aucun gain de taille du bundle n’est attribué
à cette optimisation des abonnements.

## Organisation du pipeline

La matrice de contrôle distingue le backend, le frontend et les tests navigateur.
Ces derniers n’attendent plus la fin du lint et des tests unitaires frontend.
Le backend utilise également la découverte complète de `src/**/*.spec.ts` : la
sélection précédente couvrait 95 des 171 fichiers suivis au commit de référence.
Les tests de logs, terminal, catalogue natif et reprise ne doivent pas rester
hors CI simplement parce qu’ils n’ont pas été ajoutés à une liste manuelle.
Une seule invocation Vitest découvre tous les fichiers `.browser.ts` et
`.browser.tsx` dans Chromium et WebKit. La liste manuelle précédente couvrait
20 fichiers en six invocations ; le catalogue actuel en contient 57. L’ajout
d’un nouveau test ne nécessite plus une modification du workflow pour l’exécuter.

Les contrôles de session, dictée, prévisualisation, Git, disposition mobile et
vues retenues restent couverts. Un test de workflow vérifie leur découverte,
les deux moteurs et la conservation des contrôles de sécurité. Les rapports et
captures sont toujours conservés, y compris après un échec.

La suite complète locale a exécuté 450 tests réussis et quatre captures optionnelles
du guide ignorées hors mode de génération, dans 114 combinaisons fichier/moteur. Une course
dans le test de reprise de session a été corrigée : la vérification automatique
peut déjà être en vol pendant la capture d’écran. Le test exige désormais une
nouvelle tentative après la panne, et non obligatoirement après le rétablissement
du serveur. Les assertions de reprise, absence de rejeu, brouillon, défilement,
confidentialité du diagnostic et fermeture des ressources sont maintenues.

Le build frontend Docker copie explicitement les sources, configurations de
compilation, ressources publiques, extension et scripts. Les sources des tests
restent présentes pour le contrôle TypeScript ; les README, configurations
d’éditeur et captures ne font plus partie de cette couche. Les caches de PR
restent séparés de ceux de `main`. Les scans de vulnérabilités, tests natifs et
contrôles du couple application/Manager ne sont pas supprimés.

Le [workflow de référence](https://github.com/maxhugit/mergeron/actions/runs/41285915149)
conserve les journaux de l’organisation précédente. Les durées CI dépendent
des caches et des runners : comparer les étapes sur plusieurs exécutions avant
d’annoncer un gain global de livraison.

## Vérifications et suivi

Les suites ciblées protègent les calculs, l’accès aux projets et le cycle des
badges. La validation frontend comprend l’ensemble des tests unitaires et
navigateur, TypeScript, lint et budgets de bundle. Les images et essais natifs
avec accès externe sont validés uniquement dans la CI isolée.

Les lectures globales de listes, les résolutions de dossiers actifs et les
assemblages d’historiques restent des points à mesurer avec une volumétrie
représentative avant une modification de contrat ou une pagination supplémentaire.
Les résolutions de fichiers ne doivent pas être mises en cache globalement au
prix d’une autorisation périmée. Le regroupement de builds ou la réutilisation
d’images entre PR et `main` doit conserver l’identité du commit, les scans et
les garanties de provenance.

Voir aussi [Maintenance du code](maintenance-code.md),
[Architecture](architecture.md) et [Contribuer](../CONTRIBUTING.md).
