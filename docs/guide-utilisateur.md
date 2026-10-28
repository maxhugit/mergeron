# Guide utilisateur intégré

Le guide de la plateforme est une aide HTML organisée comme un sommaire CHM,
pas un fichier Windows `.chm`. La route `/help` présente une arborescence de
chapitres et articles, un moteur de recherche local et une lecture séparée.
Les conversations simples et les agents de travail ont des chapitres distincts.

## Sources et organisation

- Interface : [help-route.tsx](../web/src/routes/help-route.tsx).
- Articles français : [manual.fr.json](../web/src/components/guide/manual.fr.json).
- Articles anglais : [manual.en.json](../web/src/components/guide/manual.en.json).
- Modèle, index et recherche : [guide-content.ts](../web/src/components/guide/guide-content.ts).
- Libellés de navigation : espaces de traduction `guide` français et anglais.
- Captures existantes : `web/public/guide`, produites avec des composants réels
  et des données d’exemple par le test de captures.

Les identifiants d’article sont communs aux deux langues et servent aux liens
`/help#guide/<identifiant>`. Ne pas les renommer sans maintenir les liens déjà
partagés. Les liens « Voir aussi » sont vérifiés dans les deux catalogues.

La recherche indexe titre, résumé, mots-clés, titres de sections, procédures,
commandes et précautions. Tous les termes doivent être présents ; casse et
accents sont ignorés. Les correspondances dans le titre sont mieux classées.
La recherche ne transmet aucune requête au serveur ou à un fournisseur IA et
ne consulte pas les données des projets. Les deux manuels sont chargés avec
la route d’aide différée, pas avec l’écran d’accueil.

## Mettre à jour l’aide avec une fonctionnalité

Lorsqu’une interface ou un comportement change :

1. Vérifier les commandes et contrôles réellement disponibles dans le code.
2. Modifier les articles concernés dans les deux langues : point d’entrée,
   prérequis et droits, procédure, effets des commandes, résultat attendu,
   erreurs et conséquences d’un arrêt ou d’une suppression.
3. Distinguer les fonctionnalités disponibles des limites et fonctions non
   implémentées. Ne pas transformer une promesse en mode d’emploi.
4. Ajouter des mots-clés usuels et des liens vers les fonctions connexes.
5. Actualiser les captures lorsqu’elles ne représentent plus les contrôles.
   Utiliser des exemples, jamais une session contenant des secrets.
6. Exécuter les tests de contenu, de navigation et de rendu responsive, ainsi
   que les vérifications de traduction et de poids du frontend.

## Vérifications

Les tests `guide-content.spec.ts` contrôlent les identifiants, les liens,
la parité des langues, les précautions et la recherche. `help-route.spec.tsx`
teste la séparation des chapitres, la navigation, les liens directs et les
résultats de recherche. `guide-captures.browser.tsx` vérifie les dimensions,
le défilement indépendant et le parcours recherche → article dans Chromium.

Le guide décrit la plateforme ; sa consultation ne donne aucun droit sur
les fonctions documentées. Les contrôles du serveur restent la référence.
