# Emplacements et connexions — consommateurs (PR 4/4)

L’interface utilise l’inventaire `/api/projects/:id/locations`, les opérations
`/connections`, `/location-transfers` et `/git`. Les anciennes routes restent
des adaptateurs de compatibilité ; elles ne contournent pas les contrôles.

- Les connexions portent le protocole, l’adresse et l’état ; les emplacements
  portent le chemin, les capacités et le mode d’accès.
- La lecture de dossiers passe par `locations/:locationId/tree`, avec un chemin
  relatif validé côté serveur. Une racine distante n’est pas parcourue comme un
  dossier local. Les copies locales révoquées restent inaccessibles.
- Git et les copies lisent les droits et l’état du modèle séparé. Les transferts
  utilisent des identifiants d’emplacement, refusent une destination distante ou
  en lecture seule et revalident avant exécution. L’aperçu reste obligatoire.
- Les ZIP ajoutent un descripteur `locationModel` contrôlé contre les références
  transportées. Les anciens ZIP restent acceptés. À l’import, les identifiants et
  chemins sont recréés, les connexions restent désactivées et aucun secret ne
  voyage. Un modèle non représentable est refusé à l’export sans perte silencieuse.

## Limites de cette transition

Les tables historiques et les triggers de la migration 0054 sont conservés pour
les écritures, les anciennes API et le retour arrière. Il n’y a ni déplacement de
fichiers, ni duplication des secrets, ni nouvelle permission d’exécution. Le
modèle permet plusieurs racines par connexion, mais leur création indépendante
et la suppression des adaptateurs historiques ne font pas partie de cette PR.
Les notes PR2 décrivent l’état de la migration à son introduction ; cette note
décrit les consommateurs actuels.
