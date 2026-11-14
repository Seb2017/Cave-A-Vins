/**
 * Proxy Apps Script pour la cave à vin.
 * Déploiement : Déployer > Nouveau déploiement > Application Web
 *   - Exécuter en tant que : Moi
 *   - Accès : Tous, même anonyme (ou restreindre selon besoin)
 * Colle l'URL de déploiement dans GAS_URL en haut de cave.html.
 *
 * Clé API : Extensions > Propriétés du projet > Propriétés du script
 *   -> ajouter CLAUDE_API_KEY = ta clé Anthropic
 */

/**
 * Proxy Apps Script pour la cave à vin.
 * Déploiement : Déployer > Nouveau déploiement > Application Web
 *   - Exécuter en tant que : Moi
 *   - Accès : Tous, même anonyme (ou restreindre selon besoin)
 * Colle l'URL de déploiement dans GAS_URL en haut de cave.html.
 *
 * Clé API : Extensions > Propriétés du projet > Propriétés du script
 *   -> ajouter CLAUDE_API_KEY = ta clé Anthropic
 *   -> ajouter SHEET_ID = l'ID du Google Sheet qui sert de base de données
 *      (crée un Sheet vide, l'ID est dans son URL entre /d/ et /edit)
 *      Les onglets "Bouteilles" et "Modules" sont créés automatiquement
 *      au premier appel s'ils n'existent pas.
 */

const BOTTLE_HEADERS = ['id','position','module','domaine','appellation','millesime','couleur','format','cepages','apo_deb','apo_fin','source_guide','prix','qte','statut','date_ajout','date_sortie','tag_nfc_id'];
const MODULE_HEADERS = ['room','id','name','type','rows','cols','depth'];

function doPost(e) {
  const body = JSON.parse(e.postData.contents);

  if (body.action === 'ocr_etiquette') {
    return ocrEtiquette(body.image, body.mime || 'image/jpeg');
  }
  if (body.action === 'estimer_apogee') {
    return estimerApogee(body);
  }
  if (body.action === 'rechercher_domaine') {
    return rechercherDomaine(body.query);
  }
  if (body.action === 'get_state') {
    return getState();
  }
  if (body.action === 'save_bottle') {
    return saveBottle(body.bottle);
  }
  if (body.action === 'save_modules') {
    return saveModules(body.room, body.modules);
  }
  if (body.action === 'suggerer_accord') {
    return suggererAccord(body.contexte, body.bouteilles);
  }

  return jsonResponse({ error: 'action inconnue' });
}

function suggererAccord(contexte, bouteilles) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');

  const systemPrompt =
    "Tu es un sommelier expérimenté. On te fournit la liste des bouteilles RÉELLEMENT disponibles dans une cave " +
    "précise (position, domaine, appellation, millésime, couleur, cépages, statut de maturité), ainsi que le " +
    "contexte du repas décrit par l'utilisateur (plat, occasion, nombre de convives...). " +
    "Propose 2 à 3 bouteilles EXCLUSIVEMENT tirées de cette liste — ne propose jamais une bouteille absente de la " +
    "liste fournie, n'invente rien. " +
    "Le statut 'aboire' signale une bouteille en fin de fenêtre de dégustation : privilégie-la raisonnablement si " +
    "elle convient à l'occasion, sans forcer un accord qui ne tiendrait pas la route juste pour cette raison. " +
    "Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, sans balises markdown : " +
    "{ \"suggestions\": [ { \"position\": \"...\", \"domaine\": \"...\", \"appellation\": \"...\", " +
    "\"millesime\": \"...\", \"raison\": \"1-2 phrases en français expliquant l'accord, et l'urgence si pertinente\" } ] }";

  const payload = {
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: "Contexte du repas : " + contexte + "\n\nBouteilles disponibles (JSON) :\n" + JSON.stringify(bouteilles)
    }]
  };

  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const result = JSON.parse(response.getContentText());

  if (result.error) {
    return jsonResponse({ error: result.error.message || 'Erreur API Claude' });
  }

  const textBlock = (result.content || []).find(b => b.type === 'text');
  if (!textBlock) {
    return jsonResponse({ error: 'Pas de réponse du modèle' });
  }

  try {
    const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
    return jsonResponse(JSON.parse(cleaned));
  } catch (err) {
    return jsonResponse({ error: 'JSON invalide retourné par le modèle', raw: textBlock.text });
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

// ---------- IA (OCR, apogée, recherche producteur) ----------

function rechercherDomaine(query) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');

  const systemPrompt =
    "Tu aides à retrouver un producteur/domaine viticole à partir d'un nom partiel ou approximatif. " +
    "Utilise la recherche web pour identifier les producteurs réels correspondants. " +
    "Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, sans balises markdown : " +
    "{ \"candidats\": [ { \"domaine\": \"nom exact du producteur\", \"appellation\": \"appellation principale\", \"region\": \"région viticole\" } ] }. " +
    "Maximum 5 candidats, les plus plausibles en premier. Liste vide si rien de fiable trouvé.";

  const payload = {
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
    system: systemPrompt,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{
      role: 'user',
      content: "Producteur de vin recherché (nom partiel) : \"" + query + "\". Donne les candidats en JSON strict."
    }]
  };

  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const result = JSON.parse(response.getContentText());

  if (result.error) {
    return jsonResponse({ error: result.error.message || 'Erreur API Claude' });
  }

  const textBlocks = (result.content || []).filter(b => b.type === 'text');
  const lastText = textBlocks[textBlocks.length - 1];
  if (!lastText) {
    return jsonResponse({ error: 'Pas de réponse finale du modèle' });
  }

  try {
    const cleaned = lastText.text.replace(/```json|```/g, '').trim();
    return jsonResponse(JSON.parse(cleaned));
  } catch (err) {
    return jsonResponse({ error: 'JSON invalide retourné par le modèle', raw: lastText.text });
  }
}

function estimerApogee(body) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');

  const systemPrompt =
    "Tu estimes la fenêtre de dégustation optimale (apogée) d'un vin précis. " +
    "Procède en plusieurs recherches web si nécessaire, avec des formulations différentes : " +
    "d'abord le nom exact du domaine + millésime, puis si rien de solide, le domaine seul, " +
    "puis en dernier recours l'appellation + le style du vin (sans le domaine) pour une estimation " +
    "générique basée sur le profil de l'appellation. Ne t'arrête pas après une seule recherche infructueuse. " +
    "Base-toi sur des guides reconnus si tu les trouves (Revue du Vin de France, Bettane & Desseauve, " +
    "Wine Advocate/Parker, Vivino, cavistes en ligne avec fiches techniques), sinon sur ta connaissance " +
    "générale du style de l'appellation et du cépage. " +
    "Une estimation générique par appellation vaut mieux qu'un abandon : mentionne-le honnêtement dans 'note' " +
    "plutôt que de renvoyer des champs vides. Ne renvoie des champs vides QUE si le vin est vraiment trop " +
    "obscur pour émettre même une estimation générique raisonnable. " +
    "Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, sans balises markdown, avec les champs : " +
    "apo_deb (année de début, nombre), apo_fin (année de fin, nombre), " +
    "source_guide (nom de la source si trouvée, sinon 'estimation par style/appellation'), " +
    "note (une phrase courte en français précisant si c'est une donnée exacte ou une estimation générique).";

  const query = [body.domaine, body.appellation, body.millesime, body.couleur, body.cepages]
    .filter(Boolean).join(', ');

  const payload = {
    model: 'claude-sonnet-4-6',
    max_tokens: 1800,
    system: systemPrompt,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{
      role: 'user',
      content: "Vin : " + query + ". Donne la fenêtre de dégustation optimale (apogée) en JSON strict. Essaie plusieurs recherches avant de conclure."
    }]
  };

  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const result = JSON.parse(response.getContentText());

  if (result.error) {
    return jsonResponse({ error: result.error.message || 'Erreur API Claude' });
  }

  const textBlocks = (result.content || []).filter(b => b.type === 'text');
  const lastText = textBlocks[textBlocks.length - 1];
  if (!lastText) {
    return jsonResponse({ error: 'Pas de réponse finale du modèle (recherche web sans synthèse)' });
  }

  try {
    const cleaned = lastText.text.replace(/```json|```/g, '').trim();
    return jsonResponse(JSON.parse(cleaned));
  } catch (err) {
    return jsonResponse({ error: 'JSON invalide retourné par le modèle', raw: lastText.text });
  }
}

function ocrEtiquette(base64Image, mimeType) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');

  const systemPrompt =
    "Tu extrais les informations d'une étiquette de vin à partir d'une photo, avec la plus grande rigueur possible. " +
    "Repères habituels des étiquettes françaises : le domaine/château/producteur est souvent le texte le plus grand " +
    "ou le plus mis en avant graphiquement (pas nécessairement en haut) ; l'appellation est le texte associé à la " +
    "mention 'Appellation ... Contrôlée' ou 'AOC/AOP', ou le nom de la région/zone viticole indiqué séparément du " +
    "nom du domaine ; le millésime est une année à 4 chiffres plausible (entre 1900 et l'année actuelle), affichée " +
    "seule, généralement bien visible ; les cépages sont parfois absents de l'étiquette (ne les invente jamais s'ils " +
    "n'y figurent pas) ; le degré d'alcool est un nombre suivi de '% vol' ou '° '. " +
    "Distingue bien le nom du domaine du nom de l'appellation : ce sont deux informations différentes, ne mets " +
    "jamais la même valeur dans les deux champs sauf si l'étiquette ne montre vraiment qu'un seul de ces deux noms. " +
    "Si un champ n'est pas clairement lisible ou n'apparaît pas sur l'étiquette, laisse-le vide ('') plutôt que de " +
    "deviner ou d'extrapoler — une valeur fausse est pire qu'un champ vide. " +
    "Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, sans balises markdown. " +
    "Champs attendus (laisse vide '' si illisible ou absent) : " +
    "domaine (producteur/château/domaine), appellation, millesime (année, nombre), " +
    "couleur (une valeur parmi: Rouge, Blanc, Rosé, Effervescent, Liquoreux), " +
    "cepages (chaîne, séparés par des virgules), degre (degré d'alcool en %, nombre), " +
    "format (une valeur parmi: 75cl, 37.5cl, Magnum, Autre).";

  const payload = {
    model: 'claude-sonnet-4-6',
    max_tokens: 700,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mimeType, data: base64Image }
        },
        { type: 'text', text: "Examine attentivement cette étiquette de vin avant de répondre. Extrait les champs, réponds en JSON strict." }
      ]
    }]
  };

  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const result = JSON.parse(response.getContentText());

  if (result.error) {
    return jsonResponse({ error: result.error.message || 'Erreur API Claude' });
  }

  const textBlock = (result.content || []).find(b => b.type === 'text');
  if (!textBlock) {
    return jsonResponse({ error: 'Pas de texte retourné par le modèle' });
  }

  let parsed;
  try {
    const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return jsonResponse({ error: 'JSON invalide retourné par le modèle', raw: textBlock.text });
  }

  return jsonResponse(parsed);
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
