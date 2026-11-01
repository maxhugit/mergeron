# Mises à jour en développement

Les installations DEV et production utilisent le même moteur transactionnel.
Le mode `dev-fast` a été supprimé : le Manager le refuse, y compris lors d’un
appel direct à son API. Les sauvegardes d’anciennes opérations restent lisibles
avec leur politique enregistrée.

Dans **Serveur → Version actuelle**, sélectionner les composants à mettre à jour,
vérifier le plan puis confirmer. Le Manager lui-même se met à jour sur l’hôte.
Dans **Restauration**, choisir la stratégie complète, minimale ou aucune et
le nombre maximal de sauvegardes à conserver. Voir
[Sauvegarde et restauration](sauvegarde-restauration.md).
