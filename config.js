// ============================================================================
//  SETTINGS - this is the only file you need to edit.
//
//  Change the text between the quotes or backticks, then save.
//  Keep the commas and the quote marks. Text in `backticks` can contain
//  apostrophes; text in 'single quotes' cannot.
// ============================================================================
window.CONFIG = {

  // ---- Look and wording ----
  title: 'Prince George Area Climbs',          // name in the top bar and browser tab
  aboutText: `*Work in Progress* Use at your own discretion. Info might be outdated, incomplete or just plain wrong. Climbing is dangerous so use your noodle. If you notice something wrong, missing, or incomplete, make a comment on the Google Sheet linked below.If you leave a name, you're more likely to see the changes. Can add topo pics, route descriptions, new areas, name changes, etc. https://docs.google.com/spreadsheets/d/1F4jvO5HjpNIxdscrlI7-NUmeslyER3ehrnJz-cSDEcs/edit?usp=sharing`,  // intro above the area list (leave blank for none)
  headerColor: '#001E13',                      // top bar colour
  gradeTextColor: '#b3261e',                   // colour of the grade in route lists

  // ---- Map ----
  defaultBasemap: 'Map',                       // background when the page opens: 'Map', 'Satellite' or 'Topo'
  areaZoom: 16,                               // how close the map zooms when you click an area (higher = closer, max about 18)

  showLegend: true,                            // false = remove the grade colour key from the map (visitors can also click it to collapse it)

  // ---- What to show ----
  hideUnverified: false,                       // true = hide routes marked Unverified / Needs review
  showStatusTags: true,                        // true = show small status labels on routes

  // ---- Google Sheet links (File > Share > Publish to web > pick a tab > CSV) ----
  // Leave a link blank to use the matching .csv file in this folder instead.
  sheets: {
    areas:      'https://docs.google.com/spreadsheets/d/e/2PACX-1vQCEMaOwar9UgSqCSFTdPYK4KiDOmCLPjX5V3aJblnTdYLprK9uR7OVkKpqqeP-iqBeS9KH5b5ylvW-/pub?gid=221886419&single=true&output=csv',
    routes:     'https://docs.google.com/spreadsheets/d/e/2PACX-1vQCEMaOwar9UgSqCSFTdPYK4KiDOmCLPjX5V3aJblnTdYLprK9uR7OVkKpqqeP-iqBeS9KH5b5ylvW-/pub?gid=1698386841&single=true&output=csv',
    topos:      'https://docs.google.com/spreadsheets/d/e/2PACX-1vQCEMaOwar9UgSqCSFTdPYK4KiDOmCLPjX5V3aJblnTdYLprK9uR7OVkKpqqeP-iqBeS9KH5b5ylvW-/pub?gid=1234353708&single=true&output=csv',
    topoRoutes: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQCEMaOwar9UgSqCSFTdPYK4KiDOmCLPjX5V3aJblnTdYLprK9uR7OVkKpqqeP-iqBeS9KH5b5ylvW-/pub?gid=1559094142&single=true&output=csv',
    parking:    'https://docs.google.com/spreadsheets/d/e/2PACX-1vQCEMaOwar9UgSqCSFTdPYK4KiDOmCLPjX5V3aJblnTdYLprK9uR7OVkKpqqeP-iqBeS9KH5b5ylvW-/pub?gid=1977395802&single=true&output=csv',
    approaches: ''
  },

  // ---- Trail lines ----
  // Names of the .geojson trail files you uploaded next to index.html.
  // Each line in a file needs an Area_ID field. Missing files are skipped.
  trailFiles: ['eveningrocktrail.geojson', 'koatrail.geojson', 'upperfrasertrail.geojson']
};
