# Mise en forme des messages

Retour à l’[index documentaire](README.md).

Les demandes envoyées à un agent et ses réponses affichent les retours à la ligne
simples, sans exiger deux espaces en fin de ligne. LF, CRLF et CR sont reconnus.
Les paragraphes restent des blocs Markdown ; les lignes vides supplémentaires
entre les blocs principaux, ainsi que celles au début et à la fin du texte,
restent visibles. Les titres, listes et tableaux partagent leur présentation
entre les demandes et les réponses. Une liste démarrant à 3 conserve ce numéro ;
les alignements gauche, centre et droite des tableaux sont respectés.

Les nouvelles demandes gardent leurs espaces et sauts de ligne à l’envoi et à
l’enregistrement. Un texte composé uniquement d’espaces reste refusé. Cela vaut
également pour le texte envoyé depuis Chat simple. Les espaces déjà supprimés
par une ancienne version ne peuvent pas être reconstitués ; les retours internes
encore présents dans l’historique bénéficient immédiatement du nouveau rendu.

La réception progressive et le message terminé utilisent le même traitement de
mise en page. Le Markdown incomplet peut naturellement évoluer pendant sa
réception. La coloration des blocs de code attend la fin du message ; leur
indentation, les lignes internes et les séquences littérales `\n` ne sont jamais
réécrites en retours. Les mentions de fichiers et contrôles de liens conservent
leur fonctionnement. Le contenu HTML n’est pas activé.

## Implémentation

`remark-message-layout.ts` transforme les sauts de ligne des nœuds texte Markdown
en nœuds de rupture. Les blocs de code, le code en ligne et les nœuds HTML sont
exclus. Les positions dans le texte source permettent de représenter les lignes
vides supplémentaires entre les blocs racine avec des espaces verticaux légers,
sans créer une multitude de paragraphes. Aucun remplacement global de `\n` n’est
appliqué au contenu brut.

`message-block-components.tsx` centralise les titres, paragraphes, listes et
tableaux. Les attributs de numérotation et d’alignement autorisés sont conservés.
Les composants spécialisés de code, mentions et liens restent séparés.

La validation de contenu distingue le test « message vide » de la valeur envoyée :
`trim()` sert au premier, mais ne remplace plus la demande originale. Le rendu
immédiat et l’historique réutilisent ainsi le même contenu. Aucune migration de
la base ou modification des permissions n’est nécessaire.

La copie formatée conserve les ruptures dans ses représentations HTML et texte,
les alignements et la numérotation. Les sauts utilisés seulement pour indenter
le HTML généré ne sont pas copiés une seconde fois. Les espaces de début d’un
bloc de code sont conservés. Le nettoyage des scripts, contrôles d’application et
liens dangereux reste actif.

## Vérification

Les tests couvrent les fins de ligne LF/CRLF/CR, les paragraphes et lignes vides,
les ruptures Markdown explicites, la numérotation, les titres, l’alignement des
tableaux, les mentions, le retour depuis l’historique, la copie et les contenus
HTML/liens non sûrs. Les tests de saisie et de service vérifient la transmission
et l’enregistrement du texte original, ainsi que le refus d’un message vide.

Les tests navigateur utilisent les vrais composants dans Chromium et WebKit à
390 et 1 280 pixels. Ils vérifient les hauteurs des lignes, les styles calculés,
l’absence de débordement horizontal et la stabilité lors du passage de réception
à terminé. Ils produisent les captures `message-formatting-390.png` et
`message-formatting-1280.png` dans le répertoire de preuves ignoré par Git.
