# Mise à jour rapide en développement

Le Manager propose `dev-fast` uniquement pour une stack dont l'environnement est
`development` et dont le nom n'est pas celui de la production (`mergeron`). La
production refuse ce mode côté Manager, même si un client l'envoie manuellement.
Le mode standard reste disponible et conserve sa copie séquentielle.

Le mode rapide conserve **toute la sauvegarde**, l'arrêt cohérent des trois
services, les contrôles de santé, les confirmations et la restauration complète
des données en cas de retour arrière. Il ne désactive aucune migration SQL.
L'absence de nouvelle migration ne prouve pas qu'une version ne modifiera pas
d'autres fichiers au démarrage : elle ne justifie donc pas de supprimer la copie.

Optimisations :

- Jusqu'à huit copies de fichiers indépendants en parallèle, avec les mêmes
  synchronisations sur disque, permissions, propriétaires et protections contre
  les liens symboliques. Les sous-dossiers restent séquentiels pour ne pas
  multiplier la concurrence. Une erreur attend la fin des copies déjà engagées
  avant le retour arrière ; aucune sauvegarde partielle n'est marquée complète.
- Une image locale peut être réutilisée seulement si la demande contient une
  empreinte SHA-256 immuable et que Docker confirme exactement cette empreinte.
  Un tag mutable est toujours téléchargé normalement. Si l'image manque ou ne
  peut pas être vérifiée, le téléchargement normal reste obligatoire.

Le mode fait partie de l'empreinte du plan confirmé et est revérifié à l'exécution.
L'interface ne l'affiche que si le Manager annonce sa prise en charge en dev.
La vitesse dépend du stockage et du nombre de fichiers ; aucun temps de mise à
jour n'est garanti. Les sauvegardes existantes ne sont jamais supprimées par ce mode.
