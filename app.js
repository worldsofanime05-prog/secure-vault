document.addEventListener('DOMContentLoaded', () => {
  let masterKey = null, vault = [], unlocked = false, selectedSet = new Set(), autoLockId = null;
  const DEFAULT_CATS = ['Social','Email','Banking','Shopping','Work','Other'];
  const $ = id => document.getElementById(id);

  // --- AES-256-GCM Crypto ---
  const CANARY='SECUREVAULT_CANARY_V2';
  const PBKDF2_ITERATIONS = 600000;  // OWASP 2024 recommendation for SHA-256
  const LEGACY_ITERATIONS = 100000;  // Migration fallback for existing vaults
  // Legacy hash — kept only for migrating old vaults to canary format
  function simpleHash(s){let h=0;for(let i=0;i<s.length;i++){h=((h<<5)-h)+s.charCodeAt(i);h|=0}return h.toString(36)}

  async function deriveKey(password, salt, iterations=PBKDF2_ITERATIONS){
    const enc=new TextEncoder();
    const km=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveKey']);
    return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations,hash:'SHA-256'},km,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  }
  async function encrypt(text, password){
    const enc=new TextEncoder();
    const salt=crypto.getRandomValues(new Uint8Array(16));
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const key=await deriveKey(password,salt);
    const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,enc.encode(text));
    const combined=new Uint8Array(salt.length+iv.length+ct.byteLength);
    combined.set(salt,0);combined.set(iv,16);combined.set(new Uint8Array(ct),28);
    return btoa(String.fromCharCode(...combined));
  }
  async function decrypt(encoded, password){
    const data=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
    const salt=data.slice(0,16),iv=data.slice(16,28),ct=data.slice(28);
    // Try current iteration count first
    try{
      const key=await deriveKey(password,salt,PBKDF2_ITERATIONS);
      const dec=await crypto.subtle.decrypt({name:'AES-GCM',iv},key,ct);
      return new TextDecoder().decode(dec);
    }catch{
      // Fallback to legacy 100K iterations for migration
      const key=await deriveKey(password,salt,LEGACY_ITERATIONS);
      const dec=await crypto.subtle.decrypt({name:'AES-GCM',iv},key,ct);
      return new TextDecoder().decode(dec);
    }
  }
  function getStrength(p){let s=0;if(p.length>=8)s++;if(p.length>=14)s++;if(p.length>=20)s++;if(/[a-z]/.test(p))s++;if(/[A-Z]/.test(p))s++;if(/[0-9]/.test(p))s++;if(/[^a-zA-Z0-9]/.test(p))s++;return s<=3?'weak':s<=5?'medium':'strong'}
  function escapeHtml(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}

  // --- Categories ---
  function loadCategories(){
    try{const d=localStorage.getItem('sv3d_cats');if(d)return JSON.parse(d)}catch{}
    return [...DEFAULT_CATS];
  }
  function saveCategories(cats){localStorage.setItem('sv3d_cats',JSON.stringify(cats))}
  function getCategories(){return loadCategories()}

  function populateCategorySelect(selId, selected){
    const sel=$(selId); if(!sel)return;
    const cats=getCategories(); sel.innerHTML='';
    cats.forEach(c=>{const o=document.createElement('option');o.value=c;o.textContent=c;sel.appendChild(o)});
    if(selected && cats.includes(selected)) sel.value=selected;
  }
  function populateFilterDropdown(){
    const sel=$('vaultCategoryFilter'); if(!sel)return;
    const cats=getCategories(); const v=sel.value;
    sel.innerHTML='<option value="">All Categories</option>';
    cats.forEach(c=>{const o=document.createElement('option');o.value=c;o.textContent=c;sel.appendChild(o)});
    if(v) sel.value=v;
  }

  // --- Vault persistence ---
  async function loadVault(){try{const d=localStorage.getItem('sv3d_vault');if(d&&masterKey){vault=JSON.parse(await decrypt(d,masterKey))}}catch{vault=[]}}
  async function saveVault(){
    if(masterKey)localStorage.setItem('sv3d_vault',await encrypt(JSON.stringify(vault),masterKey));
    renderVault(); updateStats(); updateAnalyticsBars(vault);
    if(typeof pushToCloud==='function')pushToCloud();
  }

  // --- Toast ---
  function showToast(msg,type='success'){
    const t=$('toast');t.textContent=(type==='success'?'✅ ':'❌ ')+msg;
    t.className='toast show '+type;setTimeout(()=>t.className='toast',2500);
  }

  // --- Stats ---
  function animateCounter(id,target){
    const el=$(id);if(!el)return;const start=parseInt(el.textContent)||0;const dur=600;const t0=performance.now();
    function tick(now){const p=Math.min((now-t0)/dur,1);el.textContent=Math.round(start+(target-start)*p);if(p<1)requestAnimationFrame(tick)}
    requestAnimationFrame(tick);
  }
  function updateStats(){
    let strong=0,medium=0,weak=0,dupes=0;const pwds=new Set();
    vault.forEach(v=>{const s=getStrength(v.password);if(s==='strong')strong++;else if(s==='medium')medium++;else weak++;if(pwds.has(v.password))dupes++;pwds.add(v.password)});
    const cats=new Set(vault.map(v=>v.category));
    animateCounter('statTotal',vault.length);animateCounter('statStrong',strong);
    animateCounter('statMedium',medium);animateCounter('statWeak',weak);
    animateCounter('statCategories',cats.size);animateCounter('statDuplicates',dupes);
    const avgEl=$('statAvgStrength');
    if(avgEl){if(vault.length===0)avgEl.textContent='—';else{const sc=vault.reduce((a,v)=>{const s=getStrength(v.password);return a+(s==='strong'?3:s==='medium'?2:1)},0)/vault.length;avgEl.textContent=sc>=2.5?'Strong':sc>=1.5?'Med':'Weak'}}
    const oldEl=$('statOldest');
    if(oldEl){if(vault.length===0)oldEl.textContent='—';else{const now=Date.now();let oldest=now;vault.forEach(v=>{if(v.created&&v.created<oldest)oldest=v.created});oldEl.textContent=Math.floor((now-oldest)/86400000)}}
  }

  // --- Render ---
  function renderVault(filter){
    filter = filter || $('vaultSearch').value || '';
    const catFilter = $('vaultCategoryFilter').value;
    const sortBy = $('vaultSort').value;
    let filtered = vault.filter(v=>
      (v.site.toLowerCase().includes(filter.toLowerCase())||v.username.toLowerCase().includes(filter.toLowerCase())||v.category.toLowerCase().includes(filter.toLowerCase()))
      && (!catFilter || v.category===catFilter)
    );
    // Sort
    filtered.sort((a,b)=>{
      if(sortBy==='newest')return(b.created||0)-(a.created||0);
      if(sortBy==='oldest')return(a.created||0)-(b.created||0);
      if(sortBy==='az')return a.site.localeCompare(b.site);
      if(sortBy==='za')return b.site.localeCompare(a.site);
      if(sortBy==='strength'){const m={weak:0,medium:1,strong:2};return(m[getStrength(a.password)]||0)-(m[getStrength(b.password)]||0)}
      return 0;
    });

    const vg=$('vaultGrid'); vg.innerHTML='';
    if(!unlocked){vg.innerHTML='<div class="vault-empty"><div class="empty-icon">&#x1F510;</div><p>Unlock your vault to view passwords.</p></div>';hideVaultActions();return}
    if(filtered.length===0){vg.innerHTML='<div class="vault-empty"><div class="empty-icon">&#x1F512;</div><p>No passwords found.</p></div>';hideVaultActions();return}

    $('vaultActionsBar').style.display='flex';
    $('vaultFooterActions').style.display='flex';
    updateSelectedCount();

    filtered.forEach((item,idx)=>{
      const realIdx=vault.indexOf(item);const strength=getStrength(item.password);
      const card=document.createElement('div');card.className='pwd-card';card.style.animation=`fadeInUp .5s ease ${idx*.05}s both`;
      const age=item.created?Math.floor((Date.now()-item.created)/86400000):null;
      card.innerHTML=`
        <input type="checkbox" class="card-select" data-idx="${realIdx}" ${selectedSet.has(realIdx)?'checked':''}>
        <div class="pwd-card-header">
          <div class="pwd-card-icon">${item.site.charAt(0)}</div>
          <div class="pwd-card-info"><h4>${escapeHtml(item.site)}</h4><span>${escapeHtml(item.category)}</span></div>
        </div>
        <div class="pwd-card-meta">
          <span>&#x1F464; ${escapeHtml(item.username)}</span>
          ${age!==null?`<span>&#x1F4C5; ${age}d ago</span>`:''}
        </div>
        <div class="pwd-card-field">
          <input type="password" value="${escapeHtml(item.password)}" readonly id="pwdField${realIdx}">
          <button class="js-toggle" title="Show/Hide">&#x1F441;</button>
          <button class="js-copy" title="Copy">&#x1F4CB;</button>
        </div>
        <div class="strength-bar"><div class="strength-bar-fill strength-${strength}"></div></div>
        <div class="pwd-card-actions">
          <button class="js-edit">&#x270F;&#xFE0F; Edit</button>
          <button class="btn-delete js-delete">&#x1F5D1;&#xFE0F; Delete</button>
        </div>`;
      card.querySelector('.pwd-card-header').addEventListener('click',()=>window.viewDetail(realIdx));
      card.querySelector('.js-toggle').addEventListener('click',()=>window.togglePwd(realIdx));
      card.querySelector('.js-copy').addEventListener('click',()=>window.copyPwd(realIdx));
      card.querySelector('.js-edit').addEventListener('click',()=>window.editPwd(realIdx));
      card.querySelector('.js-delete').addEventListener('click',()=>window.deletePwd(realIdx));
      card.querySelector('.card-select').addEventListener('change',e=>{
        if(e.target.checked)selectedSet.add(realIdx);else selectedSet.delete(realIdx);
        updateSelectedCount();
      });
      vg.appendChild(card);
    });
  }
  function hideVaultActions(){$('vaultActionsBar').style.display='none';$('vaultFooterActions').style.display='none'}
  function updateSelectedCount(){$('selectedCount').textContent=selectedSet.size+' selected';$('selectAllPwds').checked=selectedSet.size===vault.length&&vault.length>0}

  // --- Global functions ---
  window.togglePwd=idx=>{const f=$('pwdField'+idx);f.type=f.type==='password'?'text':'password'};
  let clipClearTimer=null;
  window.copyPwd=idx=>{
    navigator.clipboard.writeText(vault[idx].password);
    showToast('Copied! Clipboard clears in 30s');
    clearTimeout(clipClearTimer);
    clipClearTimer=setTimeout(()=>{
      navigator.clipboard.writeText('').then(()=>showToast('Clipboard cleared','success')).catch(()=>{});
    },30000);
  };
  window.editPwd=idx=>{
    $('modalAddTitle').textContent='✏️ Edit Password';$('editIndex').value=idx;
    $('pwdSite').value=vault[idx].site;$('pwdUser').value=vault[idx].username;
    populateCategorySelect('pwdCategory',vault[idx].category);
    $('pwdPass').value=vault[idx].password;$('pwdPass').type='password';
    $('pwdNotes').value=vault[idx].notes||'';
    $('generatorPanel').style.display='none';$('newCategoryGroup').style.display='none';
    updatePwdStrengthUI(vault[idx].password);
    $('modalAdd').classList.add('active');
  };
  window.deletePwd=async idx=>{if(confirm('Delete this password?')){vault.splice(idx,1);selectedSet.clear();await saveVault();showToast('Deleted')}};
  window.viewDetail=idx=>{
    const item=vault[idx];if(!item)return;
    $('detailTitle').textContent=item.site;
    const age=item.created?Math.floor((Date.now()-item.created)/86400000)+'d ago':'N/A';
    $('detailContent').innerHTML=`
      <div class="detail-row"><label>Website</label><div class="detail-value">${escapeHtml(item.site)}</div></div>
      <div class="detail-row"><label>Username</label><div class="detail-value">${escapeHtml(item.username)}</div></div>
      <div class="detail-row"><label>Category</label><div class="detail-value">${escapeHtml(item.category)}</div></div>
      <div class="detail-row"><label>Password</label><div class="detail-value">${escapeHtml(item.password)}</div></div>
      <div class="detail-row"><label>Strength</label><div class="detail-value">${getStrength(item.password).toUpperCase()}</div></div>
      <div class="detail-row"><label>Age</label><div class="detail-value">${age}</div></div>
      ${item.notes?`<div class="detail-row"><label>Notes</label><div class="detail-value notes">${escapeHtml(item.notes)}</div></div>`:''}`;
    $('btnEditFromDetail').onclick=()=>{$('modalDetail').classList.remove('active');window.editPwd(idx)};
    $('modalDetail').classList.add('active');
  };

  // --- Password strength UI in modal ---
  function updatePwdStrengthUI(pwd){
    const fill=$('pwdStrengthFill'),label=$('pwdStrengthLabel');
    if(!pwd){fill.style.width='0';label.textContent='';return}
    const s=getStrength(pwd);
    fill.style.width=s==='weak'?'33%':s==='medium'?'66%':'100%';
    fill.style.background=s==='weak'?'var(--rose)':s==='medium'?'var(--amber)':'var(--green)';
    label.textContent=s.charAt(0).toUpperCase()+s.slice(1);
    label.style.color=fill.style.background;
  }

  // --- Password Generator ---
  function generatePassword(){
    const len=parseInt($('genLength').value);let chars='';
    if($('genUpper').checked)chars+='ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    if($('genLower').checked)chars+='abcdefghijklmnopqrstuvwxyz';
    if($('genNumbers').checked)chars+='0123456789';
    if($('genSymbols').checked)chars+='!@#$%^&*()_+-=[]{}|;:,.<>?';
    if(!chars)chars='abcdefghijklmnopqrstuvwxyz';
    let p='';const rnd=new Uint32Array(len);crypto.getRandomValues(rnd);for(let i=0;i<len;i++)p+=chars.charAt(rnd[i]%chars.length);
    $('genResult').textContent=p;return p;
  }

  // --- Export/Import ---
  function exportVault(items){
    const data=JSON.stringify({passwords:items,categories:getCategories(),exported:new Date().toISOString()},null,2);
    const blob=new Blob([data],{type:'application/json'});const url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download='securevault-backup-'+Date.now()+'.json';a.click();URL.revokeObjectURL(url);
    showToast('Exported '+items.length+' passwords');
  }
  function exportCSV(items){
    const header='Site,Username,Password,Category,Strength,Notes,Created';
    const rows=items.map(v=>{
      const esc=s=>'"'+(s||'').replace(/"/g,'""')+'"';
      const created=v.created?new Date(v.created).toLocaleDateString():'N/A';
      return [esc(v.site),esc(v.username),esc(v.password),esc(v.category),getStrength(v.password),esc(v.notes),created].join(',');
    });
    const csv=header+'\n'+rows.join('\n');
    const blob=new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download='securevault-passwords-'+Date.now()+'.csv';a.click();URL.revokeObjectURL(url);
    showToast('Exported '+items.length+' passwords as CSV');
  }
  function exportTXT(items){
    const divider='═'.repeat(50);
    let txt='SecureVault — Password Export\n';
    txt+='Exported: '+new Date().toLocaleString()+'\n';
    txt+='Total Passwords: '+items.length+'\n';
    txt+=divider+'\n\n';
    items.forEach((v,i)=>{
      const age=v.created?Math.floor((Date.now()-v.created)/86400000)+' days ago':'N/A';
      txt+='['+(i+1)+'] '+v.site+'\n';
      txt+='    Username : '+v.username+'\n';
      txt+='    Password : '+v.password+'\n';
      txt+='    Category : '+v.category+'\n';
      txt+='    Strength : '+getStrength(v.password).toUpperCase()+'\n';
      txt+='    Created  : '+(v.created?new Date(v.created).toLocaleString():'N/A')+' ('+age+')\n';
      if(v.notes) txt+='    Notes    : '+v.notes+'\n';
      txt+='\n'+divider+'\n\n';
    });
    const blob=new Blob([txt],{type:'text/plain;charset=utf-8'});const url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download='securevault-passwords-'+Date.now()+'.txt';a.click();URL.revokeObjectURL(url);
    showToast('Exported '+items.length+' passwords as text');
  }
  function importVault(file){
    const reader=new FileReader();
    reader.onload=async e=>{
      try{
        const data=JSON.parse(e.target.result);
        if(!data.passwords||!Array.isArray(data.passwords))throw new Error('Invalid');
        const count=data.passwords.length;
        data.passwords.forEach(p=>{if(p.site&&p.username&&p.password){if(!p.created)p.created=Date.now();if(!p.category)p.category='Other';vault.push(p)}});
        if(data.categories){const cats=getCategories();data.categories.forEach(c=>{if(!cats.includes(c))cats.push(c)});saveCategories(cats);populateFilterDropdown()}
        await saveVault();showToast('Imported '+count+' passwords');
      }catch{showToast('Invalid backup file','error')}
    };
    reader.readAsText(file);
  }

  // --- Auto-lock ---
  function resetAutoLock(){
    clearTimeout(autoLockId);
    const mins=parseInt($('autoLockTimer').value)||0;
    if(mins>0&&unlocked)autoLockId=setTimeout(lockVault,mins*60000);
  }
  function lockVault(){
    unlocked=false;masterKey=null;vault=[];selectedSet.clear();
    renderVault();updateStats();
    $('btnLockVault').style.display='none';
    $('autoLockOverlay').style.display='flex';
  }
  ['click','keydown','mousemove','scroll'].forEach(ev=>document.addEventListener(ev,resetAutoLock,{passive:true}));

  // --- Brute-force lockout ---
  const MAX_ATTEMPTS=5;
  function getFailedAttempts(){return parseInt(sessionStorage.getItem('sv3d_fail_count')||'0')}
  function getLockoutUntil(){return parseInt(sessionStorage.getItem('sv3d_lockout_until')||'0')}
  function recordFailedAttempt(){
    const count=getFailedAttempts()+1;
    sessionStorage.setItem('sv3d_fail_count',count);
    if(count>=MAX_ATTEMPTS){
      // Exponential backoff: 30s, 60s, 120s, 240s...
      const overMax=count-MAX_ATTEMPTS;
      const lockSec=30*Math.pow(2,Math.min(overMax,6));
      sessionStorage.setItem('sv3d_lockout_until',Date.now()+lockSec*1000);
      return lockSec;
    }
    return 0;
  }
  function clearFailedAttempts(){sessionStorage.removeItem('sv3d_fail_count');sessionStorage.removeItem('sv3d_lockout_until')}
  function getRemainingLockout(){
    const until=getLockoutUntil();
    if(!until)return 0;
    return Math.max(0,Math.ceil((until-Date.now())/1000));
  }

  // --- Master password modal ---
  function openMasterModal(){
    const hasKey=!!localStorage.getItem('sv3d_master');
    $('masterTitle').textContent=hasKey?'🔐 Unlock Vault':'🔑 Set Master Password';
    $('masterDesc').textContent=hasKey?'Enter your master password to unlock the vault.':'Create a master password to secure your vault.';
    $('masterConfirmGroup').style.display=hasKey?'none':'block';
    $('masterPass').value='';$('masterConfirm').value='';
    $('modalMaster').classList.add('active');
  }
  async function doUnlock(){
    // Check lockout
    const remaining=getRemainingLockout();
    if(remaining>0)return showToast('Too many attempts. Try again in '+remaining+'s','error');

    const pwd=$('masterPass').value;if(!pwd||pwd.length<4)return showToast('Min 4 characters','error');
    const stored=localStorage.getItem('sv3d_master');
    if(stored){
      // Canary-based verification: decrypt the stored canary with the entered password
      let verified=false;
      try{const plain=await decrypt(stored,pwd);if(plain===CANARY)verified=true}catch{}
      if(!verified){
        // Migration path: check against legacy simpleHash format
        if(stored===simpleHash(pwd)){
          // Upgrade to secure canary format on the fly
          const newCanary=await encrypt(CANARY,pwd);
          localStorage.setItem('sv3d_master',newCanary);
          verified=true;
        }
      }
      if(!verified){
        const lockSec=recordFailedAttempt();
        const fails=getFailedAttempts();
        if(lockSec>0)return showToast('Too many failed attempts. Locked for '+lockSec+'s','error');
        const left=MAX_ATTEMPTS-fails;
        return showToast('Incorrect password ('+left+' attempt'+(left===1?'':'s')+' left)','error');
      }
      clearFailedAttempts();
      masterKey=pwd;unlocked=true;await loadVault();
    }else{
      if(pwd!==$('masterConfirm').value)return showToast('Passwords don\'t match','error');
      localStorage.setItem('sv3d_master',await encrypt(CANARY,pwd));masterKey=pwd;unlocked=true;vault=[];await saveVault();
    }
    $('modalMaster').classList.remove('active');$('autoLockOverlay').style.display='none';
    $('btnLockVault').style.display='flex';
    populateFilterDropdown();populateCategorySelect('pwdCategory');
    renderVault();updateStats();rebuildAnalyticsBars(getCategories());updateAnalyticsBars(vault);
    resetAutoLock();showToast('Vault unlocked!');
    document.getElementById('vault').scrollIntoView({behavior:'smooth'});
  }

  // --- Settings: category list ---
  function renderSettingsCategories(){
    const list=$('settingsCategoryList');if(!list)return;
    const cats=getCategories();list.innerHTML='';
    cats.forEach(c=>{
      const chip=document.createElement('span');chip.className='category-chip';
      chip.innerHTML=`${escapeHtml(c)} <button class="chip-delete" title="Delete">✕</button>`;
      chip.querySelector('.chip-delete').addEventListener('click',()=>{deleteCategory(c);renderSettingsCategories()});
      list.appendChild(chip);
    });
  }
  async function deleteCategory(name){
    const cats=getCategories().filter(c=>c!==name);
    if(cats.length===0)return showToast('Need at least one category','error');
    saveCategories(cats);
    vault.forEach(v=>{if(v.category===name)v.category=cats[0]});
    await saveVault();populateFilterDropdown();rebuildAnalyticsBars(cats);updateAnalyticsBars(vault);
    showToast('Category "'+name+'" deleted');
  }

  // ===================== EVENT LISTENERS =====================

  $('btnGetStarted').addEventListener('click',openMasterModal);
  $('btnCancelMaster').addEventListener('click',()=>$('modalMaster').classList.remove('active'));
  $('btnSubmitMaster').addEventListener('click',doUnlock);
  $('masterPass').addEventListener('keydown',e=>{if(e.key==='Enter')doUnlock()});

  // Add password
  $('btnAddPwd').addEventListener('click',()=>{
    if(!unlocked)return openMasterModal();
    $('modalAddTitle').textContent='➕ Add New Password';$('editIndex').value=-1;
    $('pwdSite').value='';$('pwdUser').value='';$('pwdPass').value='';$('pwdPass').type='password';$('pwdNotes').value='';
    populateCategorySelect('pwdCategory');$('generatorPanel').style.display='none';$('newCategoryGroup').style.display='none';
    updatePwdStrengthUI('');$('modalAdd').classList.add('active');
  });
  $('btnCancelAdd').addEventListener('click',()=>$('modalAdd').classList.remove('active'));
  $('btnSaveAdd').addEventListener('click',async ()=>{
    const site=$('pwdSite').value.trim(),user=$('pwdUser').value.trim(),pass=$('pwdPass').value,cat=$('pwdCategory').value,notes=$('pwdNotes').value.trim();
    if(!site||!user||!pass)return showToast('Site, username and password required','error');
    const idx=parseInt($('editIndex').value);
    if(idx>=0){vault[idx]={...vault[idx],site,username:user,password:pass,category:cat,notes,modified:Date.now()};showToast('Updated!')}
    else{vault.push({site,username:user,password:pass,category:cat,notes,created:Date.now()});showToast('Added!')}
    await saveVault();$('modalAdd').classList.remove('active');
  });

  // Password field strength
  $('pwdPass').addEventListener('input',e=>updatePwdStrengthUI(e.target.value));
  $('btnTogglePwdVisibility').addEventListener('click',()=>{const f=$('pwdPass');f.type=f.type==='password'?'text':'password'});

  // Category create/delete in add modal
  $('btnNewCategory').addEventListener('click',()=>{$('newCategoryGroup').style.display='block';$('newCategoryInput').value='';$('newCategoryInput').focus()});
  $('btnCancelNewCat').addEventListener('click',()=>$('newCategoryGroup').style.display='none');
  $('btnConfirmNewCat').addEventListener('click',()=>{
    const name=$('newCategoryInput').value.trim();if(!name)return showToast('Enter a name','error');
    const cats=getCategories();if(cats.includes(name))return showToast('Already exists','error');
    cats.push(name);saveCategories(cats);populateCategorySelect('pwdCategory',name);populateFilterDropdown();
    rebuildAnalyticsBars(cats);$('newCategoryGroup').style.display='none';showToast('Category "'+name+'" created');
  });
  $('btnDeleteCategory').addEventListener('click',async ()=>{
    const sel=$('pwdCategory').value;
    if(!confirm('Delete category "'+sel+'"? Passwords in it will move to the first available category.'))return;
    await deleteCategory(sel);populateCategorySelect('pwdCategory');
  });

  // Generator
  $('btnOpenGen').addEventListener('click',()=>{const p=$('generatorPanel');p.style.display=p.style.display==='none'?'block':'none';if(p.style.display==='block')generatePassword()});
  $('genLength').addEventListener('input',e=>{$('genLengthVal').textContent=e.target.value;generatePassword()});
  ['genUpper','genLower','genNumbers','genSymbols'].forEach(id=>$(id).addEventListener('change',generatePassword));
  $('btnGenerate').addEventListener('click',generatePassword);
  $('btnUseGen').addEventListener('click',()=>{$('pwdPass').value=$('genResult').textContent;updatePwdStrengthUI($('pwdPass').value);showToast('Applied!')});

  // Search, filter, sort
  $('vaultSearch').addEventListener('input',()=>renderVault());
  $('vaultCategoryFilter').addEventListener('change',()=>renderVault());
  $('vaultSort').addEventListener('change',()=>renderVault());

  // Bulk actions
  $('selectAllPwds').addEventListener('change',e=>{if(e.target.checked)vault.forEach((_,i)=>selectedSet.add(i));else selectedSet.clear();renderVault()});
  $('btnBulkDelete').addEventListener('click',async ()=>{
    if(selectedSet.size===0)return showToast('None selected','error');
    if(!confirm('Delete '+selectedSet.size+' passwords?'))return;
    vault=vault.filter((_,i)=>!selectedSet.has(i));selectedSet.clear();await saveVault();showToast('Deleted');
  });
  $('btnBulkExport').addEventListener('click',()=>{
    if(selectedSet.size===0)return showToast('None selected','error');
    exportVault(vault.filter((_,i)=>selectedSet.has(i)));
  });

  // Export/Import
  $('btnExportVault').addEventListener('click',()=>exportVault(vault));
  $('btnImportVault').addEventListener('click',()=>$('importFileInput').click());
  $('importFileInput').addEventListener('change',e=>{if(e.target.files[0])importVault(e.target.files[0]);e.target.value=''});

  // Export All modal
  $('btnExportAll').addEventListener('click',()=>{
    if(!unlocked)return openMasterModal();
    if(vault.length===0)return showToast('Vault is empty','error');
    $('modalExport').classList.add('active');
  });
  $('btnCancelExport').addEventListener('click',()=>$('modalExport').classList.remove('active'));
  $('btnExportJSON').addEventListener('click',()=>{exportVault(vault);$('modalExport').classList.remove('active')});

  // Plaintext export confirmation flow
  let pendingPlaintextExport=null;
  function requestPlaintextExport(type){
    pendingPlaintextExport=type;
    $('modalExport').classList.remove('active');
    $('plaintextConfirmInput').value='';
    $('btnConfirmPlaintext').disabled=true;
    $('modalPlaintextConfirm').classList.add('active');
    $('plaintextConfirmInput').focus();
  }
  $('btnExportCSV').addEventListener('click',()=>requestPlaintextExport('csv'));
  $('btnExportTXT').addEventListener('click',()=>requestPlaintextExport('txt'));
  $('plaintextConfirmInput').addEventListener('input',e=>{
    $('btnConfirmPlaintext').disabled=e.target.value.trim()!=='EXPORT';
  });
  $('btnCancelPlaintext').addEventListener('click',()=>{
    $('modalPlaintextConfirm').classList.remove('active');
    pendingPlaintextExport=null;
  });
  $('btnConfirmPlaintext').addEventListener('click',()=>{
    if($('plaintextConfirmInput').value.trim()!=='EXPORT')return;
    $('modalPlaintextConfirm').classList.remove('active');
    if(pendingPlaintextExport==='csv')exportCSV(vault);
    else if(pendingPlaintextExport==='txt')exportTXT(vault);
    pendingPlaintextExport=null;
  });

  // Nav
  const navToggle=$('navToggle'),navLinks=$('navLinks');
  navToggle.addEventListener('click',()=>navLinks.classList.toggle('open'));
  navLinks.addEventListener('click',()=>navLinks.classList.remove('open'));
  $('btnLockVault').addEventListener('click',lockVault);

  // Settings
  $('btnSettings').addEventListener('click',()=>{renderSettingsCategories();updateFirebaseSettingsUI();$('modalSettings').classList.add('active')});
  $('btnCloseSettings').addEventListener('click',()=>$('modalSettings').classList.remove('active'));
  $('btnSettingsAddCat').addEventListener('click',()=>{
    const name=$('settingsNewCat').value.trim();if(!name)return;
    const cats=getCategories();if(cats.includes(name))return showToast('Exists','error');
    cats.push(name);saveCategories(cats);$('settingsNewCat').value='';renderSettingsCategories();populateFilterDropdown();
    rebuildAnalyticsBars(cats);updateAnalyticsBars(vault);showToast('Added "'+name+'"');
  });
  $('autoLockTimer').addEventListener('change',resetAutoLock);
  $('btnSettingsExport').addEventListener('click',()=>exportVault(vault));
  $('btnSettingsImport').addEventListener('click',()=>$('importFileInput').click());

  // Theme toggle
  function setTheme(theme){
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('sv3d_theme', theme);
    document.querySelectorAll('.theme-btn').forEach(btn=>{
      btn.classList.toggle('active', btn.getAttribute('data-theme')===theme);
    });
  }
  // Load saved theme
  const savedTheme = localStorage.getItem('sv3d_theme') || 'dark';
  setTheme(savedTheme);
  // Button clicks
  document.querySelectorAll('.theme-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>setTheme(btn.getAttribute('data-theme')));
  });

  // Change master password
  $('btnChangeMaster').addEventListener('click',()=>{$('modalSettings').classList.remove('active');$('modalChangeMaster').classList.add('active');$('currentMasterPass').value='';$('newMasterPass').value='';$('confirmNewMasterPass').value=''});
  $('btnCancelChangeMaster').addEventListener('click',()=>$('modalChangeMaster').classList.remove('active'));
  $('btnSubmitChangeMaster').addEventListener('click',async ()=>{
    const cur=$('currentMasterPass').value,nw=$('newMasterPass').value,cf=$('confirmNewMasterPass').value;
    // Verify current password via canary decryption
    const stored=localStorage.getItem('sv3d_master');
    let verified=false;
    try{const plain=await decrypt(stored,cur);if(plain===CANARY)verified=true}catch{}
    if(!verified){if(stored===simpleHash(cur))verified=true}
    if(!verified)return showToast('Current password incorrect','error');
    if(nw.length<4)return showToast('Min 4 characters','error');
    if(nw!==cf)return showToast('Passwords don\'t match','error');
    masterKey=nw;localStorage.setItem('sv3d_master',await encrypt(CANARY,nw));await saveVault();
    $('modalChangeMaster').classList.remove('active');showToast('Master password changed!');
  });

  // Reset vault
  $('btnResetVault').addEventListener('click',()=>{
    if(!confirm('⚠️ This will DELETE everything. Are you sure?'))return;
    if(!confirm('REALLY delete ALL data?'))return;
    localStorage.removeItem('sv3d_vault');localStorage.removeItem('sv3d_master');localStorage.removeItem('sv3d_cats');
    vault=[];masterKey=null;unlocked=false;selectedSet.clear();
    renderVault();updateStats();$('btnLockVault').style.display='none';
    $('modalSettings').classList.remove('active');showToast('Vault reset');
  });

  // Detail modal
  $('btnCloseDetail').addEventListener('click',()=>$('modalDetail').classList.remove('active'));

  // Auto-unlock
  $('btnAutoUnlock').addEventListener('click',()=>{$('autoLockOverlay').style.display='none';openMasterModal()});

  // Close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach(m=>{m.addEventListener('click',e=>{if(e.target===m)m.classList.remove('active')})});

  // Scroll animations
  const observer=new IntersectionObserver(entries=>{entries.forEach(e=>{if(e.isIntersecting)e.target.classList.add('visible')})},{threshold:.15});
  document.querySelectorAll('.reveal').forEach(el=>observer.observe(el));
  const navbar=$('navbar');
  window.addEventListener('scroll',()=>{
    navbar.classList.toggle('scrolled',window.scrollY>50);
    const sections=['hero','features','vault','analytics'];let current='hero';
    sections.forEach(id=>{const s=document.getElementById(id);if(s&&window.scrollY>=s.offsetTop-200)current=id});
    document.querySelectorAll('.nav-links a').forEach(a=>a.classList.toggle('active',a.getAttribute('href')==='#'+current));
  });

  // --- Cloud Pull Callback ---
  window._onCloudPull = async function(){
    if(!unlocked || !masterKey) return;
    await loadVault();
    populateFilterDropdown(); populateCategorySelect('pwdCategory');
    renderVault(); updateStats();
    rebuildAnalyticsBars(getCategories()); updateAnalyticsBars(vault);
  };

  // --- Google Sync Buttons ---
  $('btnGoogleSign').addEventListener('click', ()=>{ if(typeof googleSignIn==='function') googleSignIn(); });
  $('btnGoogleSignOut').addEventListener('click', ()=>{ if(typeof googleSignOut==='function') googleSignOut(); });
  $('btnForceSync').addEventListener('click', ()=>{
    if(typeof pushToCloud==='function' && typeof pullFromCloud==='function'){
      pullFromCloud().then(()=>pushToCloud());
    }
  });

  // --- Firebase Setup UI ---
  function updateFirebaseSettingsUI(){
    const config = typeof getStoredFirebaseConfig==='function' ? getStoredFirebaseConfig() : null;
    const setupState = $('firebaseSetupState');
    const configuredState = $('firebaseConfiguredState');
    const banner = $('firebaseSetupBanner');
    const syncBar = $('syncStatusBar');

    if(config && config.apiKey){
      // Firebase is configured
      if(setupState) setupState.style.display='none';
      if(configuredState) configuredState.style.display='block';
      if(banner) banner.style.display='none';
      if(syncBar) syncBar.style.display='flex';
      const projId = $('firebaseProjectId');
      if(projId) projId.textContent = config.projectId || '—';
    } else {
      // No config — show setup
      if(setupState) setupState.style.display='block';
      if(configuredState) configuredState.style.display='none';
      if(banner) banner.style.display='inline-flex';
      if(syncBar) syncBar.style.display='none';
    }
  }

  // Toggle instructions
  $('btnToggleInstructions').addEventListener('click', ()=>{
    const el=$('firebaseInstructions');
    const btn=$('btnToggleInstructions');
    if(el.style.display==='none'){
      el.style.display='block'; btn.textContent='📋 Hide Setup Instructions';
    } else {
      el.style.display='none'; btn.textContent='📋 Show Setup Instructions';
    }
  });

  // Save Firebase config
  $('btnSaveFirebase').addEventListener('click', ()=>{
    const config = {
      apiKey: $('fbApiKey').value.trim(),
      authDomain: $('fbAuthDomain').value.trim(),
      projectId: $('fbProjectId').value.trim(),
      storageBucket: $('fbStorageBucket').value.trim(),
      messagingSenderId: $('fbMessagingSenderId').value.trim(),
      appId: $('fbAppId').value.trim()
    };

    // Validate required fields
    if(!config.apiKey || !config.authDomain || !config.projectId || !config.appId){
      showFirebaseStatus('Please fill in at least API Key, Auth Domain, Project ID, and App ID.', 'error');
      return;
    }

    // Save to localStorage
    if(typeof saveFirebaseConfig==='function') saveFirebaseConfig(config);

    // Initialize Firebase with the new config
    const success = typeof initFirebaseFromStorage==='function' ? initFirebaseFromStorage() : false;
    if(success){
      showFirebaseStatus('✅ Firebase configured successfully! You can now sign in with Google.', 'success');
      updateFirebaseSettingsUI();
      showToast('Firebase configured!');
    } else {
      showFirebaseStatus('❌ Failed to initialize Firebase. Please check your config values.', 'error');
    }
  });

  // Test Firebase connection
  $('btnTestFirebase').addEventListener('click', async ()=>{
    showFirebaseStatus('⏳ Testing connection...', 'loading');

    // First ensure config is saved & initialized
    const config = {
      apiKey: $('fbApiKey').value.trim(),
      authDomain: $('fbAuthDomain').value.trim(),
      projectId: $('fbProjectId').value.trim(),
      storageBucket: $('fbStorageBucket').value.trim(),
      messagingSenderId: $('fbMessagingSenderId').value.trim(),
      appId: $('fbAppId').value.trim()
    };

    if(!config.apiKey || !config.projectId){
      showFirebaseStatus('❌ Fill in at least API Key and Project ID first.', 'error');
      return;
    }

    if(typeof saveFirebaseConfig==='function') saveFirebaseConfig(config);
    if(typeof initFirebaseFromStorage==='function') initFirebaseFromStorage();

    if(typeof testFirebaseConnection==='function'){
      const result = await testFirebaseConnection();
      if(result.success){
        showFirebaseStatus('✅ ' + result.message, 'success');
      } else {
        showFirebaseStatus('❌ ' + result.message, 'error');
      }
    } else {
      showFirebaseStatus('❌ Firebase sync module not loaded.', 'error');
    }
  });

  // Clear Firebase config
  $('btnClearFirebase').addEventListener('click', ()=>{
    if(!confirm('Remove Firebase configuration? Sync will be disabled until you set it up again.')) return;
    if(typeof clearFirebaseConfig==='function') clearFirebaseConfig();
    // Clear the form fields too
    ['fbApiKey','fbAuthDomain','fbProjectId','fbStorageBucket','fbMessagingSenderId','fbAppId'].forEach(id=>{
      const el=$(id); if(el) el.value='';
    });
    updateFirebaseSettingsUI();
    showToast('Firebase config removed');
  });

  // Setup banner → opens settings scrolled to Firebase section
  $('firebaseSetupBanner').addEventListener('click', ()=>{
    renderSettingsCategories();
    $('modalSettings').classList.add('active');
    // Scroll the Firebase section into view inside the modal
    setTimeout(()=>{
      const section = $('firebaseSettingsSection');
      if(section) section.scrollIntoView({behavior:'smooth', block:'start'});
    }, 300);
  });

  function showFirebaseStatus(msg, type){
    const el=$('firebaseStatusMsg');
    if(!el) return;
    el.style.display='block';
    el.textContent=msg;
    el.className='firebase-status-msg status-'+type;
  }

  // --- INIT ---
  // Try to initialize Firebase from stored config
  if(typeof initFirebaseFromStorage === 'function'){
    initFirebaseFromStorage();
  }
  updateFirebaseSettingsUI();

  initHeroScene(); animateHero(); initAnalyticsScene();
  rebuildAnalyticsBars(getCategories()); animateAnalytics();
  populateFilterDropdown(); renderVault(); updateStats();

  // Lock vault when tab is hidden (user switches away)
  // Skip if Google sign-in popup is active (it causes visibility change)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && unlocked && !(typeof signingIn !== 'undefined' && signingIn)) lockVault();
  });
});
