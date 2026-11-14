/**
 * Proxy Apps Script pour la cave à vin — version « télécommandée ».
 *
 * Les consignes de l'IA (prompts, modèles, réglages) ne sont plus écrites ici :
 * le script les lit dans apps-script/config.json sur GitHub (relu toutes les
 * 5 minutes). Pour faire évoluer le sommelier, le scan d'étiquette, etc., il
 * suffit de modifier ce fichier sur GitHub : inutile de republier le script.
 * Si GitHub est injoignable ou le fichier invalide, le script utilise la
 * dernière version valide connue, puis en dernier recours la copie de secours
 * DEFAULT_CONFIG en bas de ce fichier.
 *
 * Déploiement : Déployer > Nouveau déploiement > Application Web
 *   - Exécuter en tant que : Moi
 *   - Accès : Tous, même anonyme (ou restreindre selon besoin)
 * Après toute modification de CE fichier : Déployer > Gérer les déploiements >
 * crayon > Version : Nouvelle version (l'URL ne change pas).
 *
 * Propriétés du script (Paramètres du projet > Propriétés du script) :
 *   -> CLAUDE_API_KEY = ta clé Anthropic (jamais sur GitHub)
 *   -> SHEET_ID = l'ID du Google Sheet qui sert de base de données
 *      Les onglets "Bouteilles" et "Modules" sont créés automatiquement
 *      au premier appel s'ils n'existent pas.
 */

const CONFIG_URL = 'https://raw.githubusercontent.com/Seb2017/Cave-A-Vins/main/apps-script/config.json';
const CONFIG_CACHE_SECONDS = 300;      // relecture du fichier de réglages : toutes les 5 minutes
const CONFIG_BACKUP_SECONDS = 21600;   // dernière version valide gardée 6 h si GitHub ne répond pas

const BOTTLE_HEADERS = ['id','position','module','domaine','appellation','millesime','couleur','format','cepages','apo_deb','apo_fin','source_guide','prix','qte','statut','date_ajout','date_sortie','tag_nfc_id'];
const MODULE_HEADERS = ['room','id','name','type','rows','cols','depth'];

function doPost(e) {
  const body = JSON.parse(e.postData.contents);

  // Données de la cave (Google Sheet)
  if (body.action === 'get_state') {
    return getState();
  }
  if (body.action === 'save_bottle') {
    return saveBottle(body.bottle);
  }
  if (body.action === 'save_modules') {
    return saveModules(body.room, body.modules);
  }

  // Vérification : quelle version des réglages est utilisée ?
  if (body.action === 'diagnostic') {
    const loaded = loadConfig();
    return jsonResponse({ ok: true, source: loaded.source, version: loaded.config.version, actions: Object.keys(loaded.config.actions) });
  }

  // Toutes les fonctions d'IA (étiquette, apogée, producteur, sommeliers...) : décrites dans config.json
  const loaded = loadConfig();
  const spec = loaded.config.actions[body.action];
  if (spec) {
    return appelIA(spec, body, loaded.config);
  }

  return jsonResponse({ error: 'action inconnue' });
}

// ---------- RÉGLAGES (config.json sur GitHub) ----------

function loadConfig() {
  const cache = CacheService.getScriptCache();
  const fresh = cache.get('config');
  if (fresh) {
    try { return { config: JSON.parse(fresh), source: 'github (cache)' }; } catch (err) {}
  }
  try {
    const res = UrlFetchApp.fetch(CONFIG_URL, { muteHttpExceptions: true });
    if (res.getResponseCode() === 200) {
      const text = res.getContentText();
      const parsed = JSON.parse(text);
      if (parsed && parsed.actions && typeof parsed.actions === 'object') {
        cache.put('config', text, CONFIG_CACHE_SECONDS);
        cache.put('config_backup', text, CONFIG_BACKUP_SECONDS);
        return { config: parsed, source: 'github' };
      }
    }
  } catch (err) { /* GitHub injoignable ou fichier invalide : on se replie ci-dessous */ }
  const backup = cache.get('config_backup');
  if (backup) {
    try { return { config: JSON.parse(backup), source: 'dernière version valide' }; } catch (err) {}
  }
  return { config: DEFAULT_CONFIG, source: 'copie de secours du script' };
}

// Remplit un modèle de texte avec les champs envoyés par la page :
//   {{champ}}            valeur du champ (les listes/objets sont convertis en JSON)
//   {{champ|défaut}}     valeur, ou « défaut » si le champ est vide
//   {{#champ}}…{{/champ}} le texte entre les deux n'apparaît que si le champ n'est pas vide
//   {{join:a,b,c}}       les champs non vides, séparés par « , »
function remplir(modele, vars) {
  const vide = v => v === undefined || v === null || v === '';
  const texte = v => (typeof v === 'object') ? JSON.stringify(v) : String(v);
  let out = String(modele || '');
  out = out.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (m, nom, inner) => vide(vars[nom]) ? '' : inner);
  out = out.replace(/\{\{join:([\w,]+)\}\}/g, (m, noms) =>
    noms.split(',').map(n => vars[n]).filter(v => !vide(v)).map(texte).join(', '));
  out = out.replace(/\{\{(\w+)(?:\|([^}]*))?\}\}/g, (m, nom, defaut) =>
    vide(vars[nom]) ? (defaut || '') : texte(vars[nom]));
  return out;
}

function collecterImages(regle, body) {
  if (!regle) return [];
  const valeur = body[regle.champ];
  let images = [];
  if (Array.isArray(valeur)) {
    images = valeur.map(img => ({ data: img.data, mime: img.mime || 'image/jpeg' }));
  } else if (valeur) {
    images = [{ data: valeur, mime: (regle.champ_mime && body[regle.champ_mime]) || 'image/jpeg' }];
  }
  return images.filter(img => img.data).slice(0, regle.max || 4);
}

// Appel générique à l'API Claude, entièrement piloté par une entrée de config.json.
function appelIA(spec, body, config) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');

  const images = collecterImages(spec.images, body);
  if (spec.images && spec.images.obligatoire && images.length === 0) {
    return jsonResponse({ error: spec.images.message_si_absent || 'Aucune photo' });
  }

  let system = spec.system || '';
  if (spec.profil && body.profil) {
    system += (config.profil_intro || '\n\nPROFIL DE GOÛT DE L\'UTILISATEUR :\n') + body.profil;
  }

  const vars = Object.assign({}, body, {
    nb_images: images.length,
    plusieurs_images: images.length > 1 ? 'oui' : ''
  });
  const texte = remplir(spec.user, vars);
  const content = images.length
    ? images.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } }))
        .concat([{ type: 'text', text: texte }])
    : texte;

  const payload = { model: spec.model, max_tokens: spec.max_tokens || 1000 };
  ['output_config', 'fallbacks', 'thinking'].forEach(k => { if (spec[k] !== undefined) payload[k] = spec[k]; });
  payload.system = system;
  if (spec.tools !== undefined) payload.tools = spec.tools;
  payload.messages = [{ role: 'user', content: content }];

  const headers = {
    'x-api-key': apiKey,
    'anthropic-version': spec.anthropic_version || config.anthropic_version || '2023-06-01'
  };
  if (spec.betas && spec.betas.length) headers['anthropic-beta'] = spec.betas.join(',');

  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: headers,
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const result = JSON.parse(response.getContentText());

  if (result.error) {
    return jsonResponse({ error: result.error.message || 'Erreur API Claude' });
  }
  if (result.stop_reason === 'refusal') {
    return jsonResponse({ error: spec.message_refus || 'La demande a été refusée par l\'IA. Reformule ou réessaie.' });
  }

  // Dernier bloc de texte (les blocs de recherche web ou de réflexion éventuels sont ignorés).
  const textBlocks = (result.content || []).filter(b => b.type === 'text');
  const lastText = textBlocks[textBlocks.length - 1];
  if (!lastText) {
    return jsonResponse({ error: 'Pas de réponse du modèle' });
  }

  try {
    const cleaned = lastText.text.replace(/```json|```/g, '').trim();
    return jsonResponse(JSON.parse(cleaned));
  } catch (err) {
    return jsonResponse({ error: 'JSON invalide retourné par le modèle', raw: lastText.text });
  }
}

// ---------- PERSISTANCE (Google Sheet) ----------

function getSheetOrCreate(name, headers) {
  const ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
  }
  return sheet;
}

function getState() {
  const bottleSheet = getSheetOrCreate('Bouteilles', BOTTLE_HEADERS);
  const moduleSheet = getSheetOrCreate('Modules', MODULE_HEADERS);

  const bottleRows = bottleSheet.getDataRange().getValues();
  const bottles = {};
  for (let i = 1; i < bottleRows.length; i++) {
    const row = bottleRows[i];
    if (!row[0]) continue;
    const bottle = {};
    BOTTLE_HEADERS.forEach((h, idx) => bottle[h] = row[idx]);
    bottles[bottle.id] = bottle;
  }

  const moduleRows = moduleSheet.getDataRange().getValues();
  const rooms = {
    buanderie: { label: 'Buanderie', modules: [] },
    cuisine: { label: 'Cuisine', modules: [] }
  };
  for (let i = 1; i < moduleRows.length; i++) {
    const row = moduleRows[i];
    if (!row[1]) continue;
    const mod = { id: row[1], name: row[2], type: row[3], rows: row[4], cols: row[5], depth: row[6] || 1 };
    const roomKey = row[0];
    if (rooms[roomKey]) rooms[roomKey].modules.push(mod);
  }

  // On ne renvoie que les pièces qui ont réellement des modules enregistrés.
  // Le client garde ses modules par défaut pour toute pièce absente ici,
  // au lieu de se faire écraser par une pièce vide.
  Object.keys(rooms).forEach(roomKey => {
    if (rooms[roomKey].modules.length === 0) delete rooms[roomKey];
  });

  return jsonResponse({ rooms, bottles });
}

function saveBottle(bottle) {
  const sheet = getSheetOrCreate('Bouteilles', BOTTLE_HEADERS);
  const data = sheet.getDataRange().getValues();
  let rowIndex = -1;
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === bottle.id) { rowIndex = i + 1; break; }
  }
  const rowValues = BOTTLE_HEADERS.map(h => bottle[h] !== undefined ? bottle[h] : '');
  if (rowIndex === -1) {
    sheet.appendRow(rowValues);
  } else {
    sheet.getRange(rowIndex, 1, 1, BOTTLE_HEADERS.length).setValues([rowValues]);
  }
  return jsonResponse({ ok: true });
}

function saveModules(room, modules) {
  const sheet = getSheetOrCreate('Modules', MODULE_HEADERS);
  const data = sheet.getDataRange().getValues();

  // Supprime les lignes existantes de cette pièce, puis réécrit à neuf.
  for (let i = data.length - 1; i >= 1; i--) {
    if (data[i][0] === room) sheet.deleteRow(i + 1);
  }
  modules.forEach(mod => {
    sheet.appendRow([room, mod.id, mod.name, mod.type, mod.rows, mod.cols, mod.depth || 1]);
  });
  return jsonResponse({ ok: true });
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- COPIE DE SECOURS DES RÉGLAGES ----------
// Utilisée seulement si config.json sur GitHub est injoignable et qu'aucune version
// valide n'est en mémoire. Identique à apps-script/config.json au moment de la publication.
const DEFAULT_CONFIG = {
  "_lisezmoi": "Réglages du script Apps Script de la cave. Le script relit ce fichier toutes les 5 minutes : pas besoin de republier le script pour qu'un changement ici soit pris en compte. Ne jamais mettre de clé API ici.",
  "version": 1,
  "anthropic_version": "2023-06-01",
  "profil_intro": "\n\nPROFIL DE GOÛT DE L'UTILISATEUR — tiens-en compte en priorité dans tes choix et tes explications, sans sacrifier la justesse de l'accord :\n",
  "actions": {
    "ocr_etiquette": {
      "model": "claude-sonnet-4-6",
      "max_tokens": 700,
      "system": "Tu extrais les informations d'une étiquette de vin à partir d'une photo, avec la plus grande rigueur possible. Repères habituels des étiquettes françaises : le domaine/château/producteur est souvent le texte le plus grand ou le plus mis en avant graphiquement (pas nécessairement en haut) ; l'appellation est le texte associé à la mention 'Appellation ... Contrôlée' ou 'AOC/AOP', ou le nom de la région/zone viticole indiqué séparément du nom du domaine ; le millésime est une année à 4 chiffres plausible (entre 1900 et l'année actuelle), affichée seule, généralement bien visible ; les cépages sont parfois absents de l'étiquette (ne les invente jamais s'ils n'y figurent pas) ; le degré d'alcool est un nombre suivi de '% vol' ou '° '. Distingue bien le nom du domaine du nom de l'appellation : ce sont deux informations différentes, ne mets jamais la même valeur dans les deux champs sauf si l'étiquette ne montre vraiment qu'un seul de ces deux noms. Si un champ n'est pas clairement lisible ou n'apparaît pas sur l'étiquette, laisse-le vide ('') plutôt que de deviner ou d'extrapoler — une valeur fausse est pire qu'un champ vide. Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, sans balises markdown. Champs attendus (laisse vide '' si illisible ou absent) : domaine (producteur/château/domaine), appellation, millesime (année, nombre), couleur (une valeur parmi: Rouge, Blanc, Rosé, Effervescent, Liquoreux), cepages (chaîne, séparés par des virgules), degre (degré d'alcool en %, nombre), format (une valeur parmi: 75cl, 37.5cl, Magnum, Autre).",
      "images": {
        "champ": "image",
        "champ_mime": "mime",
        "max": 1
      },
      "user": "Examine attentivement cette étiquette de vin avant de répondre. Extrait les champs, réponds en JSON strict."
    },
    "estimer_apogee": {
      "model": "claude-sonnet-4-6",
      "max_tokens": 1800,
      "system": "Tu estimes la fenêtre de dégustation optimale (apogée) d'un vin précis. Procède en plusieurs recherches web si nécessaire, avec des formulations différentes : d'abord le nom exact du domaine + millésime, puis si rien de solide, le domaine seul, puis en dernier recours l'appellation + le style du vin (sans le domaine) pour une estimation générique basée sur le profil de l'appellation. Ne t'arrête pas après une seule recherche infructueuse. Base-toi sur des guides reconnus si tu les trouves (Revue du Vin de France, Bettane & Desseauve, Wine Advocate/Parker, Vivino, cavistes en ligne avec fiches techniques), sinon sur ta connaissance générale du style de l'appellation et du cépage. Une estimation générique par appellation vaut mieux qu'un abandon : mentionne-le honnêtement dans 'note' plutôt que de renvoyer des champs vides. Ne renvoie des champs vides QUE si le vin est vraiment trop obscur pour émettre même une estimation générique raisonnable. Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, sans balises markdown, avec les champs : apo_deb (année de début, nombre), apo_fin (année de fin, nombre), source_guide (nom de la source si trouvée, sinon 'estimation par style/appellation'), note (une phrase courte en français précisant si c'est une donnée exacte ou une estimation générique).",
      "tools": [
        {
          "type": "web_search_20250305",
          "name": "web_search"
        }
      ],
      "user": "Vin : {{join:domaine,appellation,millesime,couleur,cepages}}. Donne la fenêtre de dégustation optimale (apogée) en JSON strict. Essaie plusieurs recherches avant de conclure."
    },
    "rechercher_domaine": {
      "model": "claude-sonnet-4-6",
      "max_tokens": 600,
      "system": "Tu aides à retrouver un producteur/domaine viticole à partir d'un nom partiel ou approximatif. Utilise la recherche web pour identifier les producteurs réels correspondants. Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, sans balises markdown : { \"candidats\": [ { \"domaine\": \"nom exact du producteur\", \"appellation\": \"appellation principale\", \"region\": \"région viticole\" } ] }. Maximum 5 candidats, les plus plausibles en premier. Liste vide si rien de fiable trouvé.",
      "tools": [
        {
          "type": "web_search_20250305",
          "name": "web_search"
        }
      ],
      "user": "Producteur de vin recherché (nom partiel) : \"{{query}}\". Donne les candidats en JSON strict."
    },
    "suggerer_accord": {
      "model": "claude-sonnet-4-6",
      "max_tokens": 1000,
      "system": "Tu es un sommelier expérimenté. On te fournit la liste des bouteilles RÉELLEMENT disponibles dans une cave précise (position, domaine, appellation, millésime, couleur, cépages, statut de maturité), ainsi que le contexte du repas décrit par l'utilisateur (plat, occasion, nombre de convives...). Propose 2 à 3 bouteilles EXCLUSIVEMENT tirées de cette liste — ne propose jamais une bouteille absente de la liste fournie, n'invente rien. Le statut 'aboire' signale une bouteille en fin de fenêtre de dégustation : privilégie-la raisonnablement si elle convient à l'occasion, sans forcer un accord qui ne tiendrait pas la route juste pour cette raison. Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, sans balises markdown : { \"suggestions\": [ { \"position\": \"...\", \"domaine\": \"...\", \"appellation\": \"...\", \"millesime\": \"...\", \"raison\": \"1-2 phrases en français expliquant l'accord, et l'urgence si pertinente\" } ] }",
      "profil": true,
      "user": "Contexte du repas : {{contexte}}\n\nBouteilles disponibles (JSON) :\n{{bouteilles}}"
    },
    "sommelier_restaurant": {
      "model": "claude-opus-5-5",
      "max_tokens": 16000,
      "output_config": {
        "effort": "low"
      },
      "fallbacks": "default",
      "betas": [
        "server-side-fallback-2026-07-01"
      ],
      "system": "Tu es le sommelier personnel de l'utilisateur, qui est au restaurant et hésite sur le vin. On te fournit une ou plusieurs photos de la carte des vins, ce qu'il mange, et parfois un budget. Lis attentivement toute la carte : vins au verre, en pichet, en demi-bouteille et en bouteille, avec leurs prix. Recommande 2 à 3 vins EXCLUSIVEMENT présents sur la carte, les mieux adaptés aux plats et à ses goûts, en respectant le budget s'il est indiqué (prix de la carte, tel qu'écrit). Classe-les du meilleur choix au moins bon. N'invente jamais un vin ni un prix : si un élément est illisible, laisse le champ vide. Si les photos ne montrent pas une carte des vins lisible, ne propose rien et explique-le dans 'remarque'. Signale aussi, s'il y en a, jusqu'à 2 vins de la carte à éviter vu ses goûts (ex. un blanc minéral et tendu). Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, sans balises markdown : { \"suggestions\": [ { \"nom\": \"domaine ou cuvée tel qu'écrit sur la carte\", \"appellation\": \"...\", \"millesime\": \"...\", \"service\": \"verre, pichet, demi-bouteille ou bouteille\", \"prix\": \"tel qu'écrit, ex. 48 €\", \"raison\": \"1-2 phrases en français : pourquoi ce vin avec ce plat, et pourquoi il devrait lui plaire\" } ], \"a_eviter\": [ { \"nom\": \"...\", \"raison\": \"une phrase courte\" } ], \"remarque\": \"une phrase facultative (carte peu lisible, alternative au verre...), sinon chaîne vide\" }",
      "profil": true,
      "images": {
        "champ": "images",
        "max": 4,
        "obligatoire": true,
        "message_si_absent": "Aucune photo de la carte des vins"
      },
      "message_refus": "Le sommelier n'a pas pu traiter ces photos. Réessaie avec d'autres photos de la carte.",
      "user": "Ce que nous mangeons : {{plats|non précisé}}{{#budget}}\nBudget maximum : {{budget}} €{{/budget}}\n\nVoici la carte des vins ({{nb_images}} photo{{#plusieurs_images}}s{{/plusieurs_images}}). Réponds en JSON strict."
    }
  }
};
