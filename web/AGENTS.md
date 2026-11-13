# Interface Mergeron

Complément aux [consignes racine](../AGENTS.md).

- Conserver les champs, boutons et comportements existants lors d’une réorganisation.
- Utiliser les composants, styles et conventions d’accessibilité existants.
  Vérifier clavier, débordements, longues valeurs et affichage mobile.
- Ajouter les libellés français et anglais dans le namespace approprié.
  Respecter les budgets i18n et de bundle sans relever les seuils pour masquer un échec.
- Réutiliser le client API généré ; coordonner tout changement de contrat avec le backend.
- Exécuter les tests, le lint et la compilation adaptés ; vérifier les catalogues
  avec pnpm check:i18n depuis web.
- Pour une modification visuelle, vérifier le vrai écran sur ordinateur et mobile
  et ouvrir les captures. Suivre la [vérification visuelle](../docs/verification-visuelle.md)
  dans l’environnement Mergeron ; signaler précisément les contrôles impossibles.
- Actualiser le guide intégré et les guides fonctionnels concernés.
