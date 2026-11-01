# Catalogue des applications : cache quotidien temporaire

Mergeron peut conserver le catalogue sur le serveur quand l’annuaire ChatGPT refuse les appels directs avec un challenge Cloudflare. Ce mécanisme est facultatif et distinct des applications réellement connectées ou autorisées.

## Activer

1. Mettre à jour le Manager et Mergeron avec les versions contenant cette fonction.
2. Dans la configuration du Manager, activer `MERGERON_APP_CATALOG_BYPARR_ENABLED=true`, puis redémarrer le Manager. Cette autorisation permet uniquement l’adaptateur de catalogue et son image Byparr validée.
3. Dans **Paramètres → Codex → Intégrations → Applications → Catalogue**, activer **Catalogue quotidien via Byparr**.

Le Manager télécharge une fois l’image Byparr validée et crée le conteneur permanent `<pile>-byparr`. Le conteneur ne publie aucun port et n’a accès ni au socket Docker ni aux fichiers de Mergeron. Le Manager expose son état, sa disponibilité et sa version dans les paramètres du catalogue. Ce service auxiliaire facultatif ne bloque pas l’installation principale. Son navigateur utilise le proxy sortant existant et vérifie les certificats TLS. Les dépendances du navigateur restent dans l’image : le cache fourni par celle-ci n’est pas masqué par un volume vide.

Le premier téléchargement démarre après activation. Ensuite une tentative est effectuée toutes les 24 heures, indépendamment des pages ouvertes dans le navigateur. Le prochain horaire est enregistré avant la tentative et conservé après redémarrage. Il n’y a pas de boucle de relance en cas d’échec. Un arrêt du serveur reporte une tentative échue à son prochain démarrage.

## Consulter les résultats et les erreurs

Dans le même écran, **Journal du catalogue** affiche les 30 dernières tentatives : date, résultat, cause et nombre d’applications téléchargées. Un avertissement visible signale l’échec de la dernière tentative, l’interruption d’un téléchargement ou un catalogue devenu ancien. Le dernier catalogue valide reste utilisable. Une préparation du conteneur qui échoue est également journalisée.

Les journaux techniques de Mergeron enregistrent uniquement un code `CATALOG_*` et éventuellement le nombre d’applications. Ils ne contiennent ni le jeton, ni les cookies, ni le corps HTML d’une erreur du fournisseur.

## Stockage et autorisations

Les fichiers sont dans `$CODEX_HOME/webui/app-directory/`, sous un nom dérivé du compte et de l’utilisateur Codex, avec des permissions privées. Ils contiennent le dernier catalogue validé et le journal ; aucun identifiant de connexion n’est conservé dans ces fichiers. Changer de compte ne réutilise pas le catalogue de l’ancien compte.

Les pages du catalogue sont servies depuis ce fichier, par petits lots. Ouvrir ou actualiser le catalogue ne déclenche pas un téléchargement de l’annuaire. Les états activé et accessible sont lus dans le runtime courant ; la présence dans le fichier ne donne jamais l’autorisation d’appeler un outil.

Le jeton du compte Codex configuré est utilisé uniquement en mémoire pour l’URL officielle de l’annuaire sur `chatgpt.com`. Les en-têtes sensibles sont supprimés des autres requêtes, y compris les scripts de challenge. Les pages suivantes sont téléchargées avec les jetons de pagination du fournisseur, sous des limites de durée et de taille. Une réponse vide, invalide, tronquée ou une pagination incohérente ne remplace pas le dernier catalogue valide.

Après chaque tentative, le Manager redémarre le même conteneur Byparr pour fermer tous les processus du navigateur, y compris après un délai dépassé. Cela évite le blocage de fermeture observé pendant le prototype. Le conteneur permanent est conservé.

## Retirer le contournement

Désactiver **Catalogue quotidien via Byparr** rétablit immédiatement les appels natifs du CLI et arrête les téléchargements planifiés. Les fichiers conservés ne sont plus utilisés pour cet accès direct. Après vérification, l’administrateur peut arrêter puis supprimer le conteneur Byparr et désactiver son option dans le Manager. Les autres composants de Mergeron restent indépendants de cet adaptateur.

L’adaptateur est isolé dans `src/apps/app-catalog*` et `manager/src/app-catalog/`. Il est destiné à être retiré lorsque l’accès natif fonctionne à nouveau. L’image est figée sur la version testée ; une autre version exige une validation et une mise à jour du Manager, plutôt qu’un changement silencieux pendant un téléchargement quotidien.
