# Installer le Manager sur Unraid

Cette adaptation est facultative. Le fonctionnement de Mergeron reste celui du
[guide d’installation commun](../installation.md).

1. Récupérer uniquement le [formulaire Manager](../../deployment/docker-man/my-mergeron-manager.xml)
   et l’ajouter aux modèles de conteneurs de l’hôte.
2. Choisir la racine persistante, le réseau du proxy, le sous-réseau libre,
   l’URL publique et les images. Vérifier les trois montages du Manager.
3. Mettre `MERGERON_INSTALL_ENABLED=true` pour cette première installation.
4. Appliquer le formulaire : le Manager prépare les dépendances manquantes.
5. Terminer la création de l’administrateur et les contrôles du guide commun.
6. Remettre `MERGERON_INSTALL_ENABLED=false` dans le formulaire et appliquer
   uniquement le remplacement du Manager, avec ses montages inchangés.

Le dossier `/mnt/user/appdata/mergeron/state` proposé n’est qu’un exemple
propre à cet hôte. Choisir votre stockage et l’inclure dans vos sauvegardes.
L’intégration hôte ajoute seulement les métadonnées d’affichage ; aucun autre
plugin, fournisseur SSO ou proxy particulier n’est requis.

Ne pas ajouter de contrôle de santé shell au formulaire : l’image Manager
n’a pas de shell et fournit déjà son propre contrôle en forme exec.
Ne pas mettre à jour ses dépendances individuellement depuis leurs formulaires :
utiliser le plan et la confirmation dans Mergeron.

Pour une instance de développement séparée, le
[formulaire Manager Dev](../../deployment/docker-man/my-mergeron-dev-manager.xml)
prépare des paramètres distincts. Les vérifier avant d’activer l’installation.
Le script `scripts/update-dev-manager.py` est un outil d’exploitation limité
à son environnement de développement configuré, pas un installateur générique.
