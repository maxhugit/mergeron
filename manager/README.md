# Gestion des installations Mergeron

Le Manager installe et maintient une instance Mergeron sur Docker Linux. Il prend
en charge le cycle de vie des composants, leurs versions, les mises à jour et
restaurations, ainsi que les ressources temporaires des environnements de test.
Il est distinct de l’application utilisée pour travailler dans les projets.

## Contenu

- `src/` contient le service de gestion, son accès Docker contrôlé, les contrôles
  de santé, l’inventaire, les sauvegardes et les prévisualisations.
- `stack-manifest.json` décrit les composants reconnus, leurs images et montages protégés.
- `scripts/` prépare notamment la bibliothèque d’archives utilisée dans l’image.
- `test/` regroupe les tests unitaires et les scénarios isolés de charge,
  redémarrage, sauvegarde et prévisualisation.

Le canal de gestion utilise un socket privé : ce n’est pas un panneau Docker
public. Les opérations restent limitées aux ressources reconnues de l’instance.
Les tests de charge utilisent des données synthétiques et ne doivent pas être
lancés sur les répertoires d’une installation réelle.

Voir [Fonctionnement du Manager](../docs/mergeron-manager.md),
[Variables](../docs/variables-manager.md) et
[Sauvegarde et restauration](../docs/sauvegarde-restauration.md).
