/**
 * push-heart-rate-csv.gs
 * ---------------------------------------------------------------------------
 * Google Apps Script - automaticky nájde denné CSV exporty tepu z Huawei
 * Health v Google Drive priečinku "Health Sync Heart rate" a pushne ich do
 * GitHub repa (data/heart_rate_raw/) cez GitHub Contents API. sync.js potom
 * pri najbližšom behu tieto CSV spracuje na Strain (viď hr_strain_daily.json).
 *
 * NASTAVENIE (urob raz):
 * 1. script.google.com → New project → sem vlož tento kód.
 * 2. Project Settings (⚙ vľavo) → Script Properties → Add script property:
 *      GITHUB_TOKEN = <fine-grained PAT, len tento repo, Contents: Read and write>
 *    (rovnaký typ tokenu, aký používaš v appke na Dashboarde - NEDÁVAJ ho
 *    priamo do kódu, len sem do Script Properties.)
 * 3. Uprav konštanty nižšie (GITHUB_OWNER, GITHUB_REPO, DRIVE_FOLDER_NAME) ak
 *    nesedia s tvojím repom/priečinkom.
 * 4. Spusti pushHeartRateCsvToGitHub() raz ručne (▶ Run) - Google si vypýta
 *    povolenia (Drive read, external requests). Over v Executions log, že to
 *    prešlo bez chyby, a skontroluj GitHub, že sa CSV objavili.
 * 5. Trigers (⏰ vľavo) → Add Trigger → funkcia pushHeartRateCsvToGitHub →
 *    Time-driven → Hour timer → Every hour (alebo podľa chuti, napr. každé
 *    2-4 hodiny stačí - stránka aj tak zobrazí najnovší stav z dashboardu).
 * ---------------------------------------------------------------------------
 */

const GITHUB_OWNER = 'xsklencik';        // TODO: uprav na svoj GitHub username/organizáciu
const GITHUB_REPO = 'recovery-main';     // TODO: uprav na presný názov repa
const GITHUB_PATH_PREFIX = 'data/heart_rate_raw/';
const DRIVE_FOLDER_NAME = 'Health Sync Heart rate';
// Ako staré súbory (podľa posledného úpravy v Drive) sa majú kontrolovať pri každom behu -
// 3 dni je dosť rezerva pre prípad, že Huawei Health/Drive sync mešká alebo doplní starší deň.
const LOOKBACK_DAYS = 3;

function pushHeartRateCsvToGitHub() {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) {
    Logger.log('❌ Chýba Script Property GITHUB_TOKEN - nastav ju v Project Settings.');
    return;
  }

  const folders = DriveApp.getFoldersByName(DRIVE_FOLDER_NAME);
  if (!folders.hasNext()) {
    Logger.log('❌ Priečinok "' + DRIVE_FOLDER_NAME + '" sa v Google Drive nenašiel.');
    return;
  }
  const folder = folders.next();
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const files = folder.getFiles();
  let checked = 0, pushed = 0, unchanged = 0, failed = 0;
  while (files.hasNext()) {
    const file = files.next();
    const name = file.getName();
    if (!/\.csv$/i.test(name)) continue;
    if (file.getLastUpdated() < cutoff) continue; // staré/nezmenené súbory netreba znova sťahovať
    checked++;
    const content = file.getBlob().getDataAsString('UTF-8');
    const result = pushFileToGitHub(name, content, token);
    if (result === 'pushed') pushed++;
    else if (result === 'unchanged') unchanged++;
    else failed++;
  }
  Logger.log('Skontrolovaných: ' + checked + ', pushnutých: ' + pushed + ', bez zmeny: ' + unchanged + ', zlyhalo: ' + failed);
}

/** Vráti 'pushed' | 'unchanged' | 'failed'. */
function pushFileToGitHub(name, content, token) {
  const apiPath = GITHUB_PATH_PREFIX + name;
  const apiUrl = 'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO +
    '/contents/' + apiPath.split('/').map(encodeURIComponent).join('/');
  const headers = {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/vnd.github+json',
  };

  // 1) Zisti, či súbor už existuje (potrebné SHA na update) a či sa obsah reálne zmenil - ak nie,
  // netreba nič pushovať (vyhne sa to zbytočným commitom pri opakovanom behu na už hotový deň).
  let sha = null;
  try {
    const getResp = UrlFetchApp.fetch(apiUrl, { headers: headers, muteHttpExceptions: true });
    if (getResp.getResponseCode() === 200) {
      const existing = JSON.parse(getResp.getContentText());
      sha = existing.sha;
      const existingContent = Utilities.newBlob(
        Utilities.base64Decode(existing.content.replace(/\n/g, ''))
      ).getDataAsString('UTF-8');
      if (existingContent === content) {
        Logger.log('= bez zmeny: ' + name);
        return 'unchanged';
      }
    }
  } catch (e) {
    Logger.log('⚠️ Chyba pri kontrole existujúceho súboru ' + name + ': ' + e.message);
  }

  // 2) Vytvor/aktualizuj súbor.
  const body = {
    message: 'Auto: heart rate CSV ' + name + ' (' + new Date().toISOString() + ')',
    content: Utilities.base64Encode(content, Utilities.Charset.UTF_8),
  };
  if (sha) body.sha = sha;

  const putResp = UrlFetchApp.fetch(apiUrl, {
    method: 'put',
    headers: headers,
    contentType: 'application/json',
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  const code = putResp.getResponseCode();
  if (code === 200 || code === 201) {
    Logger.log('✅ pushnuté: ' + name);
    return 'pushed';
  }
  Logger.log('❌ zlyhalo (' + code + '): ' + name + ' - ' + putResp.getContentText());
  return 'failed';
}
