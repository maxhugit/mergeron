# Environnement Office des agents

Les agents utilisent `/opt/office-venv/bin/python`, indépendamment du Python
système et de Mise. L’image conserve openpyxl, python-docx, python-pptx, pypdf,
reportlab et Pillow, et ajoute `aspose-cells-python==26.10.0`. LibreOffice Writer,
Calc et Impress, libgdiplus, Poppler, Ghostscript et les polices Liberation,
Carlito, Caladea et Noto sont installés dans l’image Linux.

## Pivots Excel natifs

La [skill office-files](../skills/office-files/SKILL.md) décrit les commandes.
`create_excel_pivot.py` lit un XLSX autonome et crée une nouvelle feuille Pivot,
un PivotTable, son cache et un PivotChart lié. Les champs sont sélectionnés par
leur en-tête : `--row`, `--column`, `--value`. L’agrégation fournie est SUM ; les
mesures doivent être numériques et sans formule. Le fichier source est conservé.

`normalize_excel_source.py` éclate les colonnes multivaluées spécifiées en une
ligne par valeur. Plusieurs colonnes produisent un produit cartésien ; les
mesures sont répétées, pas réparties. Ce choix modifie le sens des totaux et doit
correspondre au besoin métier. La sortie contient uniquement les valeurs.

## Licence en secret

Sur Debian Trixie, `CLR_ICU_VERSION_OVERRIDE=76` sélectionne explicitement l’ICU
système pour le runtime .NET embarqué, sans désactiver les cultures Unicode.

Aucune licence n’est livrée ni téléchargée par Mergeron. L’administrateur doit
obtenir une licence Aspose.Cells compatible avec la version figée, puis monter
le fichier dans **le conteneur applicatif** en lecture seule, par exemple :

```yaml
# À ajouter à la configuration de déploiement locale, hors dépôt.
volumes:
  - /chemin/administrateur/Aspose.Cells.lic:/opt/office-license/Aspose.Cells.lic:ro
```

Le fichier doit être lisible par UID 11002, sans être modifiable. Le chemin par
défaut peut être changé avec `ASPOSE_CELLS_LICENSE_FILE`. Aucun contenu de licence
ne doit apparaître dans les logs, Git, les artefacts CI ou les images Docker.
Les motifs `*.lic` et `*.lic.xml` sont exclus de Git et du contexte Docker.
Ne pas utiliser de licence « metered » qui contacterait un serveur externe.

Le montage dédié sous `/opt/office-license` hérite du bind en lecture seule du
sandbox. Le masquage de `/run/secrets` et des secrets administratifs est conservé.
Il ne faut pas exposer tout `/run/secrets` à l’agent pour ajouter cette licence.
Pour une installation gérée par le Manager, ajouter ce montage via sa procédure
d’adoption/configuration sur l’hôte ; ne pas modifier les binds pendant une
mise à jour ni contourner les contrôles d’adoption. Ce changement de code ne
modifie aucune installation existante et n’injecte aucune licence.

Sans licence, la création refuse de produire un fichier ordinaire. L’option
explicite `--allow-evaluation` permet les tests synthétiques et signale le mode
évaluation dans le JSON retourné. Aspose ajoute une feuille ou un filigrane
d’évaluation : les tests ne les suppriment pas et ne les cachent pas.

## Rendu et validation

`render_office.py` utilise Aspose pour exporter les XLSX contenant des pivots :
LibreOffice peut afficher leur PivotChart comme un bloc vide. Pour les autres
documents, il utilise un profil LibreOffice temporaire, `svp`, la sécurité
macro maximale et la désactivation des mises à jour externes. Il vérifie le PDF
produit (signature, pages et ouverture avec pypdf), puis transforme chaque page
en PNG avec Poppler. Les pages trop grandes, le délai dépassé, les résultats
absents et les fichiers préexistants sont refusés. Les processus descendants
sont arrêtés au dépassement du délai. Les proxys hérités restent inchangés ;
aucun téléchargement n’est nécessaire à l’exécution.

`validate_office.py` rouvre DOCX/PPTX/XLSX, vérifie les relations entre PivotTables,
pivotCacheDefinition, pivotCacheRecords et graphiques, les noms des champs, puis
rouvre les pivots avec Aspose. Il ne sauvegarde pas le document. Tous les scripts
refusent macros, ActiveX, OLE, relations externes et XML avec DTD. Les anciens
formats binaires ou macro-enabled ne sont pas acceptés par ces helpers.

`render.json` contient le nombre de pages, leurs dimensions et une indication de
page potentiellement blanche. **L’inspection visuelle reste requise** : l’agent
doit ouvrir chaque PNG, vérifier la mise en page et corriger la source avant de
livrer. Ce rapport ne certifie pas automatiquement l’absence de chevauchement.

## Tests

Les fixtures XLSX, DOCX et PPTX sont générées depuis du contenu synthétique dans
`skills/office-files/tests/fixtures.py`. Le smoke test de l’image exécute les tests
sous UID 11002, réseau désactivé, racine en lecture seule, capacités retirées et
`no-new-privileges`. Il crée et rouvre de vrais pivots, vérifie les caches, teste
la normalisation, le rejet des macros/liens/DTD et un faux succès sans PDF, puis
rend chaque format ainsi qu’un classeur à pivots en PDF et PNG. Les rendus sont
joints aux rapports de sécurité CI dans `artifacts/office-render/` pour inspection.
Les contrôles existants de liaison libxml2 et les conversions historiques sont
conservés. La CI utilise explicitement le mode évaluation, sans secret Aspose.

Références : [pivots Aspose](https://docs.aspose.com/cells/python-net/create-pivot-tables-and-pivot-charts/),
[licence et limites d’évaluation](https://docs.aspose.com/cells/python-net/licensing/).
