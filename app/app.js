// Configurazione base
const CONFIG = {
    budgetTotale: 200,
    ruoliTarget: { p: 3, d: 8, c: 8, a: 6 },
    budgetCap: { p: 0.1, d: 0.25, c: 0.35, a: 0.3 },
    myScoreWeight: 0.5
};

const STATE_FILE = "fanta_state.json";

const UNDER_BONUS = {
    U21: 0.10, U23: 0.07, U25: 0.05,
    U28: 0.02, U30: 0.00, O30: -0.02,
};

const ROLE_PRETTY = {
    p: "Portiere", d: "Difensore", c: "Centrocampista", a: "Attaccante"
};

// Stato dell'applicazione
let state = {
    csv: null,
    csvData: null,
    budgetTotale: CONFIG.budgetTotale,
    budgetLeft: CONFIG.budgetTotale,
    ruoliTarget: CONFIG.ruoliTarget,
    picked: [],
    gone: [],
    opponents: {},
    topk: 6,
};

// Funzioni di utilità
function loadState() {
    // Prima prova a caricare dal localStorage
    try {
        const savedState = localStorage.getItem(STATE_FILE);
        if (savedState) {
            state = JSON.parse(savedState);
            return true;
        }
    } catch (error) {
        console.error("Errore nel caricamento dello stato dal localStorage:", error);
    }
    
    // Se non c'è nulla nel localStorage, prova a caricare dal server
    try {
        fetch('http://localhost:3000/api/load')
            .then(response => response.json())
            .then(result => {
                if (result.success && result.data) {
                    state = result.data;
                    // Salva anche nel localStorage per accesso offline
                    localStorage.setItem(STATE_FILE, JSON.stringify(state));
                    updateUI();
                    showNotification("Stato caricato dal server!");
                    return true;
                }
            })
            .catch(error => {
                console.error("Errore nel caricamento dello stato dal server:", error);
            });
    } catch (error) {
        console.error("Errore nella chiamata API di caricamento:", error);
    }
    
    return false;
}

function saveState() {
    try {
        // Salva nel localStorage per accesso offline
        localStorage.setItem(STATE_FILE, JSON.stringify(state));
        
        // Salva anche sul server
        fetch('http://localhost:3000/api/save', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(state)
        })
        .then(response => response.json())
        .then(result => {
            if (result.success) {
                console.log('Stato salvato sul server con successo');
            } else {
                console.error('Errore nel salvataggio sul server:', result.message);
            }
        })
        .catch(error => {
            console.error('Errore nella chiamata API di salvataggio:', error);
        });
        
        return true;
    } catch (error) {
        console.error("Errore nel salvataggio dello stato:", error);
        return false;
    }
}

function showNotification(message, isError = false) {
    const notification = document.getElementById('notification');
    notification.textContent = message;
    notification.classList.remove('hidden', 'error');
    
    if (isError) {
        notification.classList.add('error');
    }
    
    setTimeout(() => {
        notification.classList.add('hidden');
    }, 3000);
}

function calculateZScores(players) {
    const grouped = {};
    
    // Raggruppa per ruolo
    for (let player of players) {
        if (!grouped[player.r]) grouped[player.r] = [];
        grouped[player.r].push(player);
    }
    
    // Calcola z-score per ogni ruolo
    for (let role in grouped) {
        const arr = grouped[role];
        const fvmpValues = arr.map(p => p.fvmp);
        const mean = fvmpValues.reduce((a, b) => a + b, 0) / fvmpValues.length;
        const std = Math.sqrt(fvmpValues.reduce((a, x) => a + Math.pow(x - mean, 2), 0) / fvmpValues.length) || 1;
        
        for (let player of arr) {
            const z = (player.fvmp - mean) / std;
            const bonus = UNDER_BONUS[player.under] || 0;
            player.score = z + bonus;
            
            if (player.priority) {
                player.score += -player.priority / 50.0;
            }
            
            if (player.myScore) {
                player.score += CONFIG.myScoreWeight * player.myScore;
            }
        }
    }
    
    return players;
}

function remainingNeeded() {
    const need = { ...state.ruoliTarget };
    for (let p of state.picked) {
        need[p.r] = Math.max(0, (need[p.r] || 0) - 1);
    }
    return need;
}

function calcBalance() {
    let score = 100;
    const budget = state.budgetTotale;
    const byRole = {};
    
    for (let role of Object.keys(CONFIG.ruoliTarget)) {
        byRole[role] = state.picked.filter(p => p.r === role).reduce((a, x) => a + x.price, 0);
        const cap = budget * CONFIG.budgetCap[role];
        
        if (byRole[role] > cap) score -= 10; // sforato cap
        if (byRole[role] < cap * 0.3) score -= 5; // troppo poco speso
    }
    
    return Math.max(0, score);
}

// Funzioni principali
function initializeApp(csvData, config) {
    // Aggiorna la configurazione
    CONFIG.budgetTotale = config.budget;
    CONFIG.ruoliTarget = config.ruoliTarget;
    CONFIG.budgetCap = config.budgetCap;
    CONFIG.myScoreWeight = config.myScoreWeight;
    
    // Aggiorna lo stato
    state.csvData = csvData;
    state.budgetTotale = config.budget;
    state.budgetLeft = config.budget;
    state.ruoliTarget = config.ruoliTarget;
    state.topk = config.topk;
    state.picked = [];
    state.gone = [];
    state.opponents = {};
    
    saveState();
    updateUI();
    showNotification("Inizializzazione completata!");
}

function getSuggestions() {
    if (!state.csvData) {
        showNotification("Nessun dato disponibile. Inizializza prima l'applicazione.", true);
        return null;
    }
    
    const need = remainingNeeded();
    const unavailable = new Set([
        ...state.gone.map(g => typeof g === 'string' ? g : g.nome),
        ...state.picked.map(p => p.nome)
    ]);
    
    // Calcola i budget per ruolo con redistribuzione
    const roleBudgets = calculateRoleBudgets();
    
    const suggestions = {};
    
    for (let role of ["p", "d", "c", "a"]) {
        if (need[role] > 0) {
            const pool = state.csvData.filter(p => p.r === role && !unavailable.has(p.nome));
            pool.sort((a, b) => b.score - a.score);
            
            const standard = pool.slice(0, state.topk);
            
            // Usa il budget calcolato con redistribuzione
            const capResiduoRuolo = roleBudgets[role].remaining;
            const ottimizzati = pool.filter(p => p.fvmp <= capResiduoRuolo && p.fvmp <= state.budgetLeft).slice(0, state.topk);
            
            suggestions[role] = {
                standard,
                ottimizzati
            };
        } else {
            suggestions[role] = {
                standard: [],
                ottimizzati: []
            };
        }
    }
    
    return suggestions;
}

function pickPlayer(name, price) {
    if (!state.csvData) {
        showNotification("Nessun dato disponibile. Inizializza prima l'applicazione.", true);
        return false;
    }
    
    const player = state.csvData.find(p => p.nome.toLowerCase() === name.toLowerCase());
    if (!player) {
        showNotification(`Giocatore "${name}" non trovato.`, true);
        return false;
    }
    
    state.picked.push({ nome: player.nome, r: player.r, price });
    state.budgetLeft = Math.max(0, state.budgetLeft - price);
    
    // Alert overspending
    const capRuolo = state.budgetTotale * CONFIG.budgetCap[player.r];
    const spesoRuolo = state.picked.filter(p => p.r === player.r).reduce((a, x) => a + x.price, 0);
    
    if (spesoRuolo > capRuolo) {
        showNotification(`Attenzione: hai sforato il cap per i ${ROLE_PRETTY[player.r]} (${spesoRuolo}/${capRuolo.toFixed(1)})`, true);
    }
    
    saveState();
    updateUI();
    return true;
}

function markPlayerGone(name, price, owner) {
    if (!state.csvData) {
        showNotification("Nessun dato disponibile. Inizializza prima l'applicazione.", true);
        return false;
    }
    
    state.gone.push({ nome: name, price, owner });
    
    // Aggiorna tracker avversari
    if (owner) {
        if (!state.opponents[owner]) {
            state.opponents[owner] = { budget: CONFIG.budgetTotale, players: [] };
        }
        state.opponents[owner].budget -= price;
        state.opponents[owner].players.push({ nome: name, price });
    }
    
    saveState();
    updateUI();
    return true;
}

function getPlayersByRole(role, k) {
    if (!state.csvData) {
        showNotification("Nessun dato disponibile. Inizializza prima l'applicazione.", true);
        return [];
    }
    
    const pool = state.csvData.filter(p => p.r === role.toLowerCase());
    pool.sort((a, b) => b.score - a.score);
    return pool.slice(0, k);
}

// UI Functions
function updateUI() {
    updateBudgetInfo();
    updateRolesNeeded();
    updateSuggestions();
    updateStateTab();
}

// Calcola il budget disponibile per ruolo, considerando la redistribuzione degli eccessi
function calculateRoleBudgets() {
    // Inizializza l'oggetto con i budget per ruolo
    const roleBudgets = {};
    let totalExcess = 0;
    
    // Prima passata: calcola il budget base e l'eccesso
    for (let role of ["p", "d", "c", "a"]) {
        const capRuolo = state.budgetTotale * CONFIG.budgetCap[role];
        const spesoRuolo = state.picked.filter(p => p.r === role).reduce((a, x) => a + x.price, 0);
        const capResiduoRuolo = capRuolo - spesoRuolo;
        
        roleBudgets[role] = {
            cap: capRuolo,
            spent: spesoRuolo,
            remaining: capResiduoRuolo,
            playersCount: state.picked.filter(p => p.r === role).length,
            targetCount: state.ruoliTarget[role]
        };
        
        // Se abbiamo sforato il cap, aggiungiamo l'eccesso al totale
        if (capResiduoRuolo < 0) {
            totalExcess += Math.abs(capResiduoRuolo);
            roleBudgets[role].remaining = 0; // Non può essere negativo
        }
    }
    
    // Seconda passata: redistribuisci l'eccesso tra i ruoli con 0 giocatori presi
    if (totalExcess > 0) {
        // Identifica i ruoli che possono ricevere l'eccesso (0 giocatori presi)
        const eligibleRoles = Object.keys(roleBudgets).filter(role => 
            roleBudgets[role].playersCount === 0 && 
            roleBudgets[role].remaining > 0);
        
        if (eligibleRoles.length > 0) {
            // Calcola quanto togliere da ciascun ruolo eleggibile
            const deductionPerRole = totalExcess / eligibleRoles.length;
            
            // Applica la deduzione
            for (let role of eligibleRoles) {
                // Non possiamo togliere più del budget rimanente
                const actualDeduction = Math.min(deductionPerRole, roleBudgets[role].remaining);
                roleBudgets[role].remaining -= actualDeduction;
                roleBudgets[role].adjustedDueToExcess = true;
            }
        }
    }
    
    return roleBudgets;
}

function updateBudgetInfo() {
    // Budget generale
    document.getElementById('budget-total').textContent = state.budgetTotale;
    document.getElementById('budget-left').textContent = state.budgetLeft;
    document.getElementById('state-budget-total').textContent = state.budgetTotale;
    document.getElementById('state-budget-left').textContent = state.budgetLeft;
    
    // Calcola i budget per ruolo con redistribuzione
    const roleBudgets = calculateRoleBudgets();
    
    // Budget per ruolo
    for (let role of ["p", "d", "c", "a"]) {
        const budgetInfo = roleBudgets[role];
        
        document.getElementById(`${role}-budget-cap`).textContent = budgetInfo.cap.toFixed(1);
        document.getElementById(`${role}-budget-spent`).textContent = budgetInfo.spent;
        document.getElementById(`${role}-budget-left`).textContent = budgetInfo.remaining.toFixed(1);
        
        // Colora in base allo stato
        const budgetItem = document.getElementById(`${role}-budget-left`);
        
        if (budgetInfo.spent > budgetInfo.cap) {
            budgetItem.style.color = 'var(--danger-color)';
        } else if (budgetInfo.spent < budgetInfo.cap * 0.3) {
            budgetItem.style.color = 'var(--warning-color)';
        } else {
            budgetItem.style.color = 'var(--success-color)';
        }
        
        // Aggiungi un indicatore se il budget è stato ridotto a causa dell'eccesso
        if (budgetInfo.adjustedDueToExcess) {
            budgetItem.innerHTML = `${budgetInfo.remaining.toFixed(1)} <span class="budget-adjusted" title="Budget ridotto per eccesso in altri ruoli">*</span>`;
        }
    }
}

function updateRolesNeeded() {
    const need = remainingNeeded();
    const container = document.getElementById('roles-needed-list');
    container.innerHTML = '';
    
    for (let role in need) {
        if (need[role] > 0) {
            const badge = document.createElement('div');
            badge.className = 'role-badge';
            badge.textContent = `${ROLE_PRETTY[role]}: ${need[role]}`;
            container.appendChild(badge);
        }
    }
}

function updateSuggestions() {
    const suggestions = getSuggestions();
    if (!suggestions) return;
    
    for (let role of ["p", "d", "c", "a"]) {
        const standardContainer = document.getElementById(`${role}-standard`);
        const optimizedContainer = document.getElementById(`${role}-optimized`);
        
        standardContainer.innerHTML = '';
        optimizedContainer.innerHTML = '';
        
        // Standard suggestions
        if (suggestions[role].standard.length === 0) {
            standardContainer.innerHTML = '<div class="player-card"><p>Nessun giocatore disponibile</p></div>';
        } else {
            suggestions[role].standard.forEach((player, index) => {
                const card = createPlayerCard(player, index + 1);
                standardContainer.appendChild(card);
            });
        }
        
        // Optimized suggestions
        if (suggestions[role].ottimizzati.length === 0) {
            optimizedContainer.innerHTML = '<div class="player-card"><p>Nessun giocatore entro budget/cap</p></div>';
        } else {
            suggestions[role].ottimizzati.forEach((player, index) => {
                const card = createPlayerCard(player, index + 1, true);
                optimizedContainer.appendChild(card);
            });
        }
    }
}

function createPlayerCard(player, index, isOptimized = false) {
    const card = document.createElement('div');
    card.className = 'player-card';
    
    const prefix = isOptimized ? 'O' : 'S';
    
    // Aggiungi icone per i ruoli
    let roleIcon = '';
    switch(player.r) {
        case 'p': roleIcon = '<i class="fas fa-hands"></i>'; break;
        case 'd': roleIcon = '<i class="fas fa-shield-alt"></i>'; break;
        case 'c': roleIcon = '<i class="fas fa-futbol"></i>'; break;
        case 'a': roleIcon = '<i class="fas fa-bolt"></i>'; break;
    }
    
    // Aggiungi badge per under
    let underClass = '';
    if (player.under === 'U21') underClass = 'success';
    else if (player.under === 'U23') underClass = 'success';
    else if (player.under === 'U25') underClass = 'warning';
    else if (player.under === 'O30') underClass = 'danger';
    
    card.innerHTML = `
        <div class="player-info">
            <div class="player-name">${roleIcon} ${prefix}${index}. ${player.nome} <span class="badge ${underClass}">${player.sq}, ${player.under}</span></div>
            <div class="player-details">
                <span class="fvmp-value">FVMP: ${player.fvmp}</span> | 
                <span class="score-value">Score: ${player.score.toFixed(2)}</span>
            </div>
        </div>
        <div class="player-actions">
            <button class="btn primary pick-suggestion" data-name="${player.nome}" data-price="${player.fvmp}" title="Acquista giocatore">
                <i class="fas fa-shopping-cart"></i> Acquista
            </button>
            <button class="btn secondary gone-suggestion" data-name="${player.nome}" data-price="${player.fvmp}" title="Segnala come acquistato da altri">
                <i class="fas fa-ban"></i> Segnala
            </button>
        </div>
    `;
    
    // Aggiungi event listeners
    card.querySelector('.pick-suggestion').addEventListener('click', function() {
        const name = this.getAttribute('data-name');
        const price = parseInt(this.getAttribute('data-price'));
        const role = this.getAttribute('data-role');
        
        // Compiliamo il form del modal di acquisto
        const searchBuyPlayer = document.getElementById('search-buy-player');
        const searchBuyPrice = document.getElementById('search-buy-price');
        const searchBuyRole = document.getElementById('search-buy-role');
        
        if (searchBuyPlayer && searchBuyPrice) {
            searchBuyPlayer.value = name;
            searchBuyPrice.value = price;
            if (searchBuyRole) searchBuyRole.value = role;
            
            // Mostriamo il modal
            const searchBuyModal = document.getElementById('search-buy-modal');
            if (searchBuyModal) {
                searchBuyModal.classList.add('active');
                document.body.classList.add('modal-open');
            } else {
                console.error('Modal di acquisto non trovato');
            }
        } else {
            console.error('Campi del form di acquisto non trovati');
        }
    });
    
    card.querySelector('.gone-suggestion').addEventListener('click', function() {
        const name = this.getAttribute('data-name');
        const price = parseInt(this.getAttribute('data-price'));
        
        // Compiliamo il form del modal di segnalazione
        const searchGonePlayer = document.getElementById('search-gone-player');
        const searchGonePrice = document.getElementById('search-gone-price');
        
        if (searchGonePlayer && searchGonePrice) {
            searchGonePlayer.value = name;
            searchGonePrice.value = price;
            
            // Mostriamo il modal
            const searchGoneModal = document.getElementById('search-gone-modal');
            if (searchGoneModal) {
                searchGoneModal.classList.add('active');
                document.body.classList.add('modal-open');
            } else {
                console.error('Modal di segnalazione non trovato');
            }
        } else {
            console.error('Campi del form di segnalazione non trovati');
        }
    });
    
    return card;
}

function updateStateTab() {
    // Aggiorna balance meter
    const balance = calcBalance();
    const balanceBar = document.getElementById('balance-bar');
    balanceBar.style.width = `${balance}%`;
    balanceBar.textContent = `${balance}%`;
    
    // Imposta il colore in base al valore
    if (balance >= 80) {
        balanceBar.style.backgroundColor = 'var(--success-color)';
    } else if (balance >= 60) {
        balanceBar.style.backgroundColor = 'var(--warning-color)';
    } else {
        balanceBar.style.backgroundColor = 'var(--danger-color)';
    }
    
    // Aggiorna lista giocatori presi
    const pickedContainer = document.getElementById('picked-players');
    pickedContainer.innerHTML = '';
    
    if (state.picked.length === 0) {
        pickedContainer.innerHTML = '<p>Nessun giocatore acquistato</p>';
    } else {
        state.picked.forEach(player => {
            const item = document.createElement('div');
            item.className = 'player-item';
            item.innerHTML = `
                <strong>${player.nome}</strong> (${ROLE_PRETTY[player.r]}) - ${player.price} crediti
            `;
            pickedContainer.appendChild(item);
        });
    }
    
    // Aggiorna lista giocatori non disponibili
    const goneContainer = document.getElementById('gone-players');
    goneContainer.innerHTML = '';
    
    if (state.gone.length === 0) {
        goneContainer.innerHTML = '<p>Nessun giocatore segnalato</p>';
    } else {
        state.gone.forEach(player => {
            const item = document.createElement('div');
            item.className = 'player-item';
            
            if (typeof player === 'string') {
                item.innerHTML = `<strong>${player}</strong>`;
            } else {
                item.innerHTML = `
                    <strong>${player.nome}</strong> - ${player.price || '?'} crediti
                    ${player.owner ? `<br><small>Proprietario: ${player.owner}</small>` : ''}
                `;
            }
            
            goneContainer.appendChild(item);
        });
    }
    
    // Aggiorna lista avversari
    const opponentsContainer = document.getElementById('opponents-list');
    opponentsContainer.innerHTML = '';
    
    const opponents = Object.keys(state.opponents);
    if (opponents.length === 0) {
        opponentsContainer.innerHTML = '<p>Nessun avversario tracciato</p>';
    } else {
        opponents.forEach(opponent => {
            const item = document.createElement('div');
            item.className = 'opponent-item';
            
            const opponentData = state.opponents[opponent];
            
            // Raggruppiamo i giocatori per ruolo
            const playersByRole = {
                p: [],
                d: [],
                c: [],
                a: []
            };
            
            // Conteggio giocatori per ruolo
            const roleCounts = {
                p: 0,
                d: 0,
                c: 0,
                a: 0
            };
            
            // Target per ruolo (standard)
            const targetRoles = {
                p: 3,  // Portieri target
                d: 8,  // Difensori target
                c: 8,  // Centrocampisti target
                a: 6   // Attaccanti target
            };
            
            // Popoliamo i gruppi per ruolo
            opponentData.players.forEach(player => {
                // Cerchiamo il giocatore completo nel dataset
                // Se state.csvData è disponibile, lo usiamo per trovare il ruolo
                const fullPlayer = state.csvData ? state.csvData.find(p => p.nome === player.nome) : null;
                if (fullPlayer) {
                    const role = fullPlayer.r.toLowerCase();
                    playersByRole[role].push(player);
                    roleCounts[role]++;
                } else {
                    // Se non troviamo il giocatore, lo mettiamo in una categoria "sconosciuto"
                    if (!playersByRole.unknown) playersByRole.unknown = [];
                    playersByRole.unknown.push(player);
                }
            });
            
            // Calcoliamo quanti giocatori mancano per ruolo
            const missingRoles = {
                p: targetRoles.p - roleCounts.p,
                d: targetRoles.d - roleCounts.d,
                c: targetRoles.c - roleCounts.c,
                a: targetRoles.a - roleCounts.a
            };
            
            // Creiamo l'header con informazioni sul budget e sui ruoli
            let headerHTML = `
                <strong>${opponent}</strong> - Budget: ${opponentData.budget} crediti
                <div class="opponent-roles-summary">
                    <span class="role-count ${missingRoles.p > 0 ? 'missing' : 'complete'}">P: ${roleCounts.p}/${targetRoles.p}</span>
                    <span class="role-count ${missingRoles.d > 0 ? 'missing' : 'complete'}">D: ${roleCounts.d}/${targetRoles.d}</span>
                    <span class="role-count ${missingRoles.c > 0 ? 'missing' : 'complete'}">C: ${roleCounts.c}/${targetRoles.c}</span>
                    <span class="role-count ${missingRoles.a > 0 ? 'missing' : 'complete'}">A: ${roleCounts.a}/${targetRoles.a}</span>
                </div>
            `;
            
            // Funzione per creare la lista di giocatori per un ruolo
            const createRoleList = (role, players, label) => {
                if (!players || players.length === 0) return '';
                
                // Ordiniamo i giocatori per prezzo decrescente
                const sortedPlayers = [...players].sort((a, b) => b.price - a.price);
                const playersList = sortedPlayers.map(p => `${p.nome} (${p.price})`).join(', ');
                
                return `<div class="opponent-role-group">
                    <span class="role-label">${label}:</span> ${playersList}
                </div>`;
            };
            
            // Aggiungiamo le liste per ogni ruolo
            let rolesHTML = '';
            rolesHTML += createRoleList('p', playersByRole.p, 'Portieri');
            rolesHTML += createRoleList('d', playersByRole.d, 'Difensori');
            rolesHTML += createRoleList('c', playersByRole.c, 'Centrocampisti');
            rolesHTML += createRoleList('a', playersByRole.a, 'Attaccanti');
            rolesHTML += createRoleList('unknown', playersByRole.unknown, 'Non classificati');
            
            item.innerHTML = headerHTML + `<div class="opponent-roles-detail">${rolesHTML}</div>`;
            opponentsContainer.appendChild(item);
        });
    }
}

// Event Listeners
document.addEventListener('DOMContentLoaded', function() {
    // Carica lo stato dal localStorage se presente
    loadState();
    
    // Inizializza la UI
    updateUI();
    
    // Gestione chiusura modali
    document.querySelectorAll('.close-modal').forEach(closeBtn => {
        closeBtn.addEventListener('click', function() {
            this.closest('.modal').classList.remove('active');
            document.body.classList.remove('modal-open');
        });
    });
    
    // Gestione conferma acquisto dal modale di ricerca
    document.getElementById('search-buy-confirm').addEventListener('click', function() {
        const playerName = document.getElementById('search-buy-player').value;
        const playerPrice = parseInt(document.getElementById('search-buy-price').value);
        
        // Eseguiamo l'acquisto
        pickPlayer(playerName, playerPrice);
        
        // Chiudiamo il modal
        document.getElementById('search-buy-modal').classList.remove('active');
        document.body.classList.remove('modal-open');
        
        // Aggiorniamo la UI
        updateUI();
    });
    
    // Gestione conferma segnalazione dal modale di ricerca
    document.getElementById('search-gone-confirm').addEventListener('click', function() {
        const playerName = document.getElementById('search-gone-player').value;
        const playerPrice = parseInt(document.getElementById('search-gone-price').value);
        const playerOwner = document.getElementById('search-gone-owner').value;
        
        if (!playerOwner) {
            showNotification('Inserisci il nome del proprietario!', 'error');
            return;
        }
        
        // Eseguiamo la segnalazione
        markPlayerGone(playerName, playerPrice, playerOwner);
        
        // Chiudiamo il modal
        document.getElementById('search-gone-modal').classList.remove('active');
        document.body.classList.remove('modal-open');
        
        // Aggiorniamo la UI
        updateUI();
    });
    
    // Tab navigation
    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');
    
    tabButtons.forEach(button => {
        button.addEventListener('click', function() {
            const tabId = this.getAttribute('data-tab');
            
            // Deactivate all tabs
            tabButtons.forEach(btn => btn.classList.remove('active'));
            tabContents.forEach(content => content.classList.remove('active'));
            
            // Activate selected tab
            this.classList.add('active');
            document.getElementById(tabId).classList.add('active');
        });
    });
    
    // Suggestion tabs
    const suggestionTabs = document.querySelectorAll('.suggestion-tab');
    
    suggestionTabs.forEach(tab => {
        tab.addEventListener('click', function() {
            const role = this.getAttribute('data-role');
            const type = this.getAttribute('data-type');
            
            // Deactivate all tabs for this role
            document.querySelectorAll(`.suggestion-tab[data-role="${role}"]`).forEach(t => t.classList.remove('active'));
            document.getElementById(`${role}-standard`).classList.add('hidden');
            document.getElementById(`${role}-optimized`).classList.add('hidden');
            
            // Activate selected tab
            this.classList.add('active');
            document.getElementById(`${role}-${type}`).classList.remove('hidden');
        });
    });
    
    // Gestione sezioni collassabili
    const toggleButtons = document.querySelectorAll('.role-toggle-btn');
    
    toggleButtons.forEach(button => {
        button.addEventListener('click', function() {
            const role = this.getAttribute('data-role');
            const content = document.getElementById(`${role}-content`);
            const icon = this.querySelector('i');
            
            // Toggle content visibility
            if (content.style.display === 'none') {
                content.style.display = 'block';
                icon.className = 'fas fa-chevron-down';
            } else {
                content.style.display = 'none';
                icon.className = 'fas fa-chevron-right';
            }
        });
    });
    
    // Pulsante per caricare il CSV di esempio
    document.getElementById('load-sample-csv').addEventListener('click', function() {
        // Mostra notifica di caricamento
        showNotification("Caricamento del file CSV di esempio in corso...");
        
        // Crea un oggetto File da caricare nel file input
        fetch('/api/sample-csv')
            .then(response => {
                if (!response.ok) {
                    throw new Error('Errore nel caricamento del file CSV di esempio');
                }
                return response.blob();
            })
            .then(blob => {
                // Crea un File object dal blob
                const file = new File([blob], 'giocatori.csv', { type: 'text/csv' });
                
                // Crea un DataTransfer object per simulare il caricamento del file
                const dataTransfer = new DataTransfer();
                dataTransfer.items.add(file);
                
                // Assegna il file al file input
                const fileInput = document.getElementById('csv-file');
                fileInput.files = dataTransfer.files;
                
                showNotification("File CSV di esempio caricato con successo!");
            })
            .catch(error => {
                console.error('Errore:', error);
                showNotification("Errore nel caricamento del file CSV di esempio", true);
            });
    });
    
    // Initialize button
    document.getElementById('init-btn').addEventListener('click', function() {
        const fileInput = document.getElementById('csv-file');
        
        if (!fileInput.files || fileInput.files.length === 0) {
            showNotification("Seleziona un file CSV.", true);
            return;
        }
        
        // Raccogliamo tutti i valori di configurazione
        const budget = parseInt(document.getElementById('budget').value) || 200;
        const topk = parseInt(document.getElementById('topk').value) || 6;
        const myScoreWeight = parseFloat(document.getElementById('my-score-weight').value) || 0.5;
        
        // Target ruoli
        const ruoliTarget = {
            p: parseInt(document.getElementById('target-p').value) || 3,
            d: parseInt(document.getElementById('target-d').value) || 8,
            c: parseInt(document.getElementById('target-c').value) || 8,
            a: parseInt(document.getElementById('target-a').value) || 6
        };
        
        // Budget cap
        let budgetCap = {};
        const capType = document.querySelector('input[name="cap-type"]:checked').value;
        
        if (capType === 'percentage') {
            // Verifichiamo che la somma sia 100%
            const pPercent = parseInt(document.getElementById('cap-p-percent').value) || 10;
            const dPercent = parseInt(document.getElementById('cap-d-percent').value) || 25;
            const cPercent = parseInt(document.getElementById('cap-c-percent').value) || 35;
            const aPercent = parseInt(document.getElementById('cap-a-percent').value) || 30;
            
            const totalPercent = pPercent + dPercent + cPercent + aPercent;
            if (totalPercent !== 100) {
                showNotification(`La somma delle percentuali deve essere 100% (attuale: ${totalPercent}%)`, true);
                return;
            }
            
            budgetCap = {
                p: pPercent / 100,
                d: dPercent / 100,
                c: cPercent / 100,
                a: aPercent / 100
            };
        } else {
            // Verifichiamo che la somma non superi il budget
            const pAbs = parseInt(document.getElementById('cap-p-abs').value) || 20;
            const dAbs = parseInt(document.getElementById('cap-d-abs').value) || 50;
            const cAbs = parseInt(document.getElementById('cap-c-abs').value) || 70;
            const aAbs = parseInt(document.getElementById('cap-a-abs').value) || 60;
            
            const totalAbs = pAbs + dAbs + cAbs + aAbs;
            if (totalAbs > budget) {
                showNotification(`La somma dei cap (${totalAbs}) supera il budget totale (${budget})`, true);
                return;
            }
            
            budgetCap = {
                p: pAbs / budget,
                d: dAbs / budget,
                c: cAbs / budget,
                a: aAbs / budget
            };
        }
        
        const file = fileInput.files[0];
        
        // Parse CSV file
        Papa.parse(file, {
            header: true,
            skipEmptyLines: true,
            complete: function(results) {
                if (results.errors.length > 0) {
                    showNotification("Errore nel parsing del CSV.", true);
                    console.error(results.errors);
                    return;
                }
                
                // Process data
                const players = results.data.map(row => {
                    return {
                        nome: row['Nome'],
                        sq: row['Sq.'],
                        under: row['Under'],
                        r: row['R.'].toLowerCase().trim(),
                        fvmp: parseFloat(row['FVMP']) || 0,
                        priority: parseInt(row['P']) || null,
                        myScore: parseFloat(row['S']) || 0
                    };
                });
                
                // Calculate scores
                const processedPlayers = calculateZScores(players);
                
                // Initialize app con la configurazione completa
                const config = {
                    budget,
                    topk,
                    myScoreWeight,
                    ruoliTarget,
                    budgetCap
                };
                
                initializeApp(processedPlayers, config);
                
                // Switch to suggest tab
                document.querySelector('.tab-btn[data-tab="suggest"]').click();
            }
        });
    });
    
    // Refresh buttons
    document.getElementById('refresh-suggest').addEventListener('click', function() {
        updateSuggestions();
        showNotification("Suggerimenti aggiornati!");
    });
    
    document.getElementById('refresh-state').addEventListener('click', function() {
        updateStateTab();
        showNotification("Stato aggiornato!");
    });
    
    // Pick player button
    document.getElementById('pick-btn').addEventListener('click', function() {
        const name = document.getElementById('pick-player').value;
        const price = parseInt(document.getElementById('pick-price').value);
        
        if (!name || isNaN(price)) {
            showNotification("Inserisci nome e prezzo validi.", true);
            return;
        }
        
        if (pickPlayer(name, price)) {
            document.getElementById('pick-player').value = '';
            document.getElementById('pick-price').value = '1';
            showNotification(`${name} acquistato per ${price} crediti!`);
        }
    });
    
    // Gone player button
    document.getElementById('gone-btn').addEventListener('click', function() {
        const name = document.getElementById('gone-player').value;
        const price = parseInt(document.getElementById('gone-price').value);
        const owner = document.getElementById('gone-owner').value;
        
        if (!name) {
            showNotification("Inserisci almeno il nome del giocatore.", true);
            return;
        }
        
        if (markPlayerGone(name, price, owner)) {
            document.getElementById('gone-player').value = '';
            document.getElementById('gone-price').value = '1';
            document.getElementById('gone-owner').value = '';
            showNotification(`${name} segnalato come non disponibile!`);
        }
    });
    
    // List role button
    document.getElementById('list-btn').addEventListener('click', function() {
        const role = document.getElementById('role-select').value;
        const k = parseInt(document.getElementById('list-k').value) || 10;
        
        const players = getPlayersByRole(role, k);
        const resultsContainer = document.getElementById('role-list-results');
        
        resultsContainer.innerHTML = '';
        
        if (players.length === 0) {
            resultsContainer.innerHTML = '<p>Nessun giocatore trovato per questo ruolo.</p>';
            return;
        }
        
        const title = document.createElement('h3');
        title.textContent = `Top ${k} ${ROLE_PRETTY[role]}`;
        resultsContainer.appendChild(title);
        
        players.forEach((player, index) => {
            const card = document.createElement('div');
            card.className = 'player-card';
            
            card.innerHTML = `
                <div class="player-info">
                    <div class="player-name">${index + 1}. ${player.nome} (${player.sq}, ${player.under})</div>
                    <div class="player-details">FVMP: ${player.fvmp} | Score: ${player.score.toFixed(2)}</div>
                </div>
                <div class="player-actions">
                    <button class="btn primary pick-list" data-name="${player.nome}" data-price="${player.fvmp}">
                        Acquista
                    </button>
                    <button class="btn secondary gone-list" data-name="${player.nome}" data-price="${player.fvmp}">
                        Segnala
                    </button>
                </div>
            `;
            
            resultsContainer.appendChild(card);
        });
        
        // Add event listeners to new buttons
        document.querySelectorAll('.pick-list').forEach(btn => {
            btn.addEventListener('click', function() {
                const name = this.getAttribute('data-name');
                const price = parseInt(this.getAttribute('data-price'));
                const role = this.getAttribute('data-role') || '';
                
                // Compiliamo il form del modal di acquisto
                const searchBuyPlayer = document.getElementById('search-buy-player');
                const searchBuyPrice = document.getElementById('search-buy-price');
                const searchBuyRole = document.getElementById('search-buy-role');
                
                if (searchBuyPlayer && searchBuyPrice) {
                    searchBuyPlayer.value = name;
                    searchBuyPrice.value = price;
                    if (searchBuyRole) searchBuyRole.value = role;
                    
                    // Mostriamo il modal
                    const searchBuyModal = document.getElementById('search-buy-modal');
                    if (searchBuyModal) {
                        searchBuyModal.classList.add('active');
                        document.body.classList.add('modal-open');
                    } else {
                        console.error('Modal di acquisto non trovato');
                    }
                } else {
                    console.error('Campi del form di acquisto non trovati');
                }
            });
        });
        
        document.querySelectorAll('.gone-list').forEach(btn => {
            btn.addEventListener('click', function() {
                const name = this.getAttribute('data-name');
                const price = parseInt(this.getAttribute('data-price'));
                
                // Compiliamo il form del modal di segnalazione
                const searchGonePlayer = document.getElementById('search-gone-player');
                const searchGonePrice = document.getElementById('search-gone-price');
                
                if (searchGonePlayer && searchGonePrice) {
                    searchGonePlayer.value = name;
                    searchGonePrice.value = price;
                    
                    // Mostriamo il modal
                    const searchGoneModal = document.getElementById('search-gone-modal');
                    if (searchGoneModal) {
                        searchGoneModal.classList.add('active');
                        document.body.classList.add('modal-open');
                    } else {
                        console.error('Modal di segnalazione non trovato');
                    }
                } else {
                    console.error('Campi del form di segnalazione non trovati');
                }
            });
        });
    });
    
    // Load saved state if available
    if (loadState()) {
        updateUI();
        showNotification("Stato precedente caricato!");
    }
    
    // Gestione toggle cap percentuale/assoluto
    const capTypeRadios = document.querySelectorAll('input[name="cap-type"]');
    const percentageCaps = document.getElementById('percentage-caps');
    const absoluteCaps = document.getElementById('absolute-caps');
    
    capTypeRadios.forEach(radio => {
        radio.addEventListener('change', function() {
            if (this.value === 'percentage') {
                percentageCaps.classList.remove('hidden');
                absoluteCaps.classList.add('hidden');
            } else {
                percentageCaps.classList.add('hidden');
                absoluteCaps.classList.remove('hidden');
                
                // Aggiorna i valori assoluti in base al budget attuale
                const budget = parseInt(document.getElementById('budget').value) || 200;
                document.getElementById('abs-budget').textContent = budget;
                
                // Converti le percentuali in valori assoluti
                const pPercent = parseInt(document.getElementById('cap-p-percent').value) || 10;
                const dPercent = parseInt(document.getElementById('cap-d-percent').value) || 25;
                const cPercent = parseInt(document.getElementById('cap-c-percent').value) || 35;
                const aPercent = parseInt(document.getElementById('cap-a-percent').value) || 30;
                
                // Verifica che la somma delle percentuali sia 100%
                const totalPercent = pPercent + dPercent + cPercent + aPercent;
                let adjustedBudget = budget;
                
                // Se la somma non è 100%, aggiustiamo i valori
                if (totalPercent !== 100) {
                    // Mostriamo un avviso
                    showNotification(`Attenzione: la somma delle percentuali è ${totalPercent}%, non 100%. I valori assoluti sono stati aggiustati.`, true);
                }
                
                // Calcola i valori assoluti basati sulle percentuali
                document.getElementById('cap-p-abs').value = Math.round(budget * pPercent / 100);
                document.getElementById('cap-d-abs').value = Math.round(budget * dPercent / 100);
                document.getElementById('cap-c-abs').value = Math.round(budget * cPercent / 100);
                document.getElementById('cap-a-abs').value = Math.round(budget * aPercent / 100);
                
                updateAbsoluteTotal();
            }
        });
    });
    
    // Aggiorna il totale percentuale quando cambiano i valori
    const percentInputs = ['cap-p-percent', 'cap-d-percent', 'cap-c-percent', 'cap-a-percent'];
    percentInputs.forEach(id => {
        document.getElementById(id).addEventListener('input', updatePercentageTotal);
    });
    
    function updatePercentageTotal() {
        const pPercent = parseInt(document.getElementById('cap-p-percent').value) || 0;
        const dPercent = parseInt(document.getElementById('cap-d-percent').value) || 0;
        const cPercent = parseInt(document.getElementById('cap-c-percent').value) || 0;
        const aPercent = parseInt(document.getElementById('cap-a-percent').value) || 0;
        
        const total = pPercent + dPercent + cPercent + aPercent;
        const totalElement = document.getElementById('percent-total');
        totalElement.textContent = total;
        
        // Cambia colore in base al totale
        if (total === 100) {
            totalElement.style.color = 'var(--success-color)';
        } else {
            totalElement.style.color = 'var(--danger-color)';
        }
    }
    
    // Aggiorna il totale assoluto quando cambiano i valori
    const absInputs = ['cap-p-abs', 'cap-d-abs', 'cap-c-abs', 'cap-a-abs'];
    absInputs.forEach(id => {
        document.getElementById(id).addEventListener('input', updateAbsoluteTotal);
    });
    
    // Aggiorna anche quando cambia il budget
    document.getElementById('budget').addEventListener('input', function() {
        const budget = parseInt(this.value) || 200;
        document.getElementById('abs-budget').textContent = budget;
        
        // Se siamo in modalità assoluta, aggiorniamo i valori in proporzione
        if (document.querySelector('input[name="cap-type"]:checked').value === 'absolute') {
            // Ottieni le percentuali attuali
            const pAbs = parseInt(document.getElementById('cap-p-abs').value) || 0;
            const dAbs = parseInt(document.getElementById('cap-d-abs').value) || 0;
            const cAbs = parseInt(document.getElementById('cap-c-abs').value) || 0;
            const aAbs = parseInt(document.getElementById('cap-a-abs').value) || 0;
            
            const oldTotal = pAbs + dAbs + cAbs + aAbs;
            if (oldTotal > 0) {
                // Aggiorna i valori in proporzione al nuovo budget
                const ratio = budget / oldTotal;
                if (ratio !== 1) { // Solo se c'è un cambiamento
                    document.getElementById('cap-p-abs').value = Math.round(pAbs * ratio);
                    document.getElementById('cap-d-abs').value = Math.round(dAbs * ratio);
                    document.getElementById('cap-c-abs').value = Math.round(cAbs * ratio);
                    document.getElementById('cap-a-abs').value = Math.round(aAbs * ratio);
                }
            } else {
                // Se il totale è 0, imposta valori predefiniti basati sulle percentuali standard
                document.getElementById('cap-p-abs').value = Math.round(budget * 0.1);
                document.getElementById('cap-d-abs').value = Math.round(budget * 0.25);
                document.getElementById('cap-c-abs').value = Math.round(budget * 0.35);
                document.getElementById('cap-a-abs').value = Math.round(budget * 0.3);
            }
        }
        
        updateAbsoluteTotal();
    });
    
    function updateAbsoluteTotal() {
        const pAbs = parseInt(document.getElementById('cap-p-abs').value) || 0;
        const dAbs = parseInt(document.getElementById('cap-d-abs').value) || 0;
        const cAbs = parseInt(document.getElementById('cap-c-abs').value) || 0;
        const aAbs = parseInt(document.getElementById('cap-a-abs').value) || 0;
        
        const total = pAbs + dAbs + cAbs + aAbs;
        const budget = parseInt(document.getElementById('budget').value) || 200;
        const totalElement = document.getElementById('abs-total');
        document.getElementById('abs-budget').textContent = budget;
        totalElement.textContent = total;
        
        // Cambia colore in base al totale
        if (total <= budget) {
            totalElement.style.color = 'var(--success-color)';
        } else {
            totalElement.style.color = 'var(--danger-color)';
        }
        
        // Aggiorna il valore visualizzato nel budget disponibile
        document.getElementById('abs-budget').textContent = budget;
    }
    
    // Inizializza i totali
    updatePercentageTotal();
    updateAbsoluteTotal();
    
    // Gestione accordion
    document.querySelectorAll('.accordion-header').forEach(header => {
        header.addEventListener('click', function() {
            const accordionId = this.getAttribute('data-accordion');
            const content = this.nextElementSibling;
            const toggleBtn = this.querySelector('.accordion-toggle');
            
            // Toggle della classe active
            content.classList.toggle('active');
            toggleBtn.classList.toggle('active');
            
            // Salva lo stato dell'accordion nelle preferenze utente
            const accordionStates = JSON.parse(localStorage.getItem('accordionStates') || '{}');
            accordionStates[accordionId] = content.classList.contains('active');
            localStorage.setItem('accordionStates', JSON.stringify(accordionStates));
        });
    });
    
    // Ripristina lo stato degli accordion dalle preferenze utente
    function restoreAccordionStates() {
        const accordionStates = JSON.parse(localStorage.getItem('accordionStates') || '{}');
        
        document.querySelectorAll('.accordion-header').forEach(header => {
            const accordionId = header.getAttribute('data-accordion');
            const content = header.nextElementSibling;
            const toggleBtn = header.querySelector('.accordion-toggle');
            
            if (accordionStates[accordionId] === false) {
                content.classList.remove('active');
                toggleBtn.classList.remove('active');
            } else if (accordionStates[accordionId] === true) {
                content.classList.add('active');
                toggleBtn.classList.add('active');
            }
        });
    }
    
    // Ripristina lo stato degli accordion al caricamento
    restoreAccordionStates();
    
    // Funzionalità di ricerca giocatori
    document.getElementById('search-btn').addEventListener('click', function() {
        searchPlayers();
    });
    
    // Abilita la ricerca anche premendo Invio nei campi di input
    document.getElementById('player-name-search').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            searchPlayers();
        }
    });
    
    document.getElementById('team-search').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            searchPlayers();
        }
    });
    
    // Reset dei filtri di ricerca
    document.getElementById('reset-search-btn').addEventListener('click', function() {
        resetSearch();
    });
    
    function resetSearch() {
        // Resetta i campi di input
        document.getElementById('player-name-search').value = '';
        document.getElementById('team-search').value = '';
        document.getElementById('role-search').value = '';
        document.getElementById('available-only-search').checked = false;
        
        // Resetta i risultati
        const resultsContainer = document.getElementById('search-results');
        resultsContainer.innerHTML = '<div class="empty-results">Inserisci i criteri di ricerca e premi Cerca</div>';
    }
    
    function searchPlayers() {
        // Ottieni i valori di ricerca
        const playerName = document.getElementById('player-name-search').value.trim().toLowerCase();
        const team = document.getElementById('team-search').value.trim().toLowerCase();
        const role = document.getElementById('role-search').value.trim();
        const availableOnly = document.getElementById('available-only-search').checked;
        
        // Verifica che almeno un campo sia compilato o il checkbox sia selezionato
        if (!playerName && !team && !role && !availableOnly) {
            showNotification('Inserisci almeno un criterio di ricerca', true);
            return;
        }
        
        // Riferimento ai risultati
        const resultsContainer = document.getElementById('search-results');
        
        // Mostra un messaggio di caricamento
        resultsContainer.innerHTML = '<div class="loading">Ricerca in corso...</div>';
        
        // Filtra i giocatori in base ai criteri di ricerca
        const results = state.csvData.filter(player => {
            const nameMatch = !playerName || player.nome.toLowerCase().includes(playerName);
            const teamMatch = !team || player.sq.toLowerCase().includes(team);
            const roleMatch = !role || player.r === role;
            
            // Verifica se il giocatore è disponibile (non è stato acquistato da nessuno)
            let isAvailable = true;
            if (availableOnly) {
                // Controlla se il giocatore è nella lista dei giocatori non disponibili
                const isGone = state.gone.includes(player.nome);
                // Controlla se il giocatore è nella lista dei giocatori acquistati
                const isPicked = state.picked.some(p => p.nome === player.nome);
                
                // Controlla se il giocatore è stato acquistato da qualche avversario
                let isPickedByOpponent = false;
                for (const opponent in state.opponents) {
                    if (state.opponents[opponent].players && 
                        state.opponents[opponent].players.some(p => p.nome === player.nome)) {
                        isPickedByOpponent = true;
                        break;
                    }
                }
                
                // Il giocatore è disponibile solo se non è né gone né picked né acquistato da avversari
                isAvailable = !isGone && !isPicked && !isPickedByOpponent;
            }
            
            return nameMatch && teamMatch && roleMatch && isAvailable;
        });
        
        // Ordina i risultati per score decrescente
        results.sort((a, b) => b.score - a.score);
        
        // Mostra i risultati
        if (results.length === 0) {
            resultsContainer.innerHTML = '<div class="no-results">Nessun giocatore trovato</div>';
        } else {
            resultsContainer.innerHTML = '';
            
            results.forEach(player => {
                // Determina se il giocatore è disponibile
                const isGone = state.gone.includes(player.nome);
                const isPicked = state.picked.some(p => p.nome === player.nome);
                
                // Crea l'elemento per il giocatore
                const playerElement = document.createElement('div');
                playerElement.className = 'search-result-item';
                if (isGone || isPicked) {
                    playerElement.classList.add('unavailable');
                }
                
                // Ottieni l'età dal campo under
                const age = player.under ? player.under : 'N/A';
                
                // Mappa il ruolo a una descrizione più leggibile
                const roleMap = {
                    'p': 'Portiere',
                    'd': 'Difensore',
                    'c': 'Centrocampista',
                    'a': 'Attaccante'
                };
                const roleName = roleMap[player.r] || player.r;
                
                // Stato del giocatore
                let statusText = '';
                if (isPicked) {
                    const pickedPlayer = state.picked.find(p => p.nome === player.nome);
                    statusText = `<span class="player-status picked">Acquistato (${pickedPlayer.price})</span>`;
                } else if (isGone) {
                    // Cerca nelle liste degli avversari
                    let ownerInfo = '';
                    for (const opponent in state.opponents) {
                        if (state.opponents[opponent].some(p => p.nome === player.nome)) {
                            const oppPlayer = state.opponents[opponent].find(p => p.nome === player.nome);
                            ownerInfo = ` - ${opponent} (${oppPlayer.price})`;
                            break;
                        }
                    }
                    statusText = `<span class="player-status gone">Non disponibile${ownerInfo}</span>`;
                }
                
                // Creiamo la struttura base del giocatore
                playerElement.innerHTML = `
                    <div class="player-info">
                        <span class="player-name">${player.nome} ${statusText}</span>
                        <div class="player-details">
                            <span class="player-team"><i class="fas fa-shield-alt"></i> ${player.sq}</span>
                            <span class="player-role"><i class="fas fa-running"></i> ${roleName}</span>
                            <span class="player-age"><i class="fas fa-birthday-cake"></i> ${age}</span>
                        </div>
                    </div>
                    <div class="player-actions">
                        <div class="player-score">
                            <span>${player.fvmp}</span>
                        </div>
                        <div class="action-buttons">
                            <button class="btn small primary buy-btn" data-player="${player.nome}" data-role="${player.r}" ${isGone || isPicked ? 'disabled' : ''}>
                                <i class="fas fa-shopping-cart"></i> Acquista
                            </button>
                            <button class="btn small secondary gone-btn" data-player="${player.nome}" data-role="${player.r}" ${isGone || isPicked ? 'disabled' : ''}>
                                <i class="fas fa-ban"></i> Segnala
                            </button>
                        </div>
                    </div>
                `;
                
                resultsContainer.appendChild(playerElement);
            });
            
            // Aggiungiamo gli event listener per i pulsanti Acquista e Segnala
            setupSearchResultsButtons();
        }
    }
    
    // Funzione per configurare i pulsanti nei risultati di ricerca
    function setupSearchResultsButtons() {
        // Rimuoviamo prima eventuali event listener esistenti per evitare duplicati
        document.querySelectorAll('#search-results .buy-btn').forEach(button => {
            button.replaceWith(button.cloneNode(true));
        });
        
        document.querySelectorAll('#search-results .gone-btn').forEach(button => {
            button.replaceWith(button.cloneNode(true));
        });
        
        // Gestione pulsanti Acquista
        document.querySelectorAll('#search-results .buy-btn').forEach(button => {
            if (!button.disabled) {
                button.addEventListener('click', function(e) {
                    e.preventDefault();
                    const playerName = this.getAttribute('data-player');
                    const playerRole = this.getAttribute('data-role');
                    
                    // Compiliamo il form del modal di acquisto
                    const searchBuyPlayer = document.getElementById('search-buy-player');
                    const searchBuyRole = document.getElementById('search-buy-role');
                    
                    if (searchBuyPlayer && searchBuyRole) {
                        searchBuyPlayer.value = playerName;
                        searchBuyRole.value = playerRole;
                        
                        // Mostriamo il modal
                        const searchBuyModal = document.getElementById('search-buy-modal');
                        if (searchBuyModal) {
                            searchBuyModal.classList.add('active');
                            document.body.classList.add('modal-open');
                        } else {
                            console.error('Modal di acquisto non trovato');
                        }
                    } else {
                        console.error('Campi del form di acquisto non trovati');
                    }
                });
            }
        });
        
        // Gestione pulsanti Segnala
        document.querySelectorAll('#search-results .gone-btn').forEach(button => {
            if (!button.disabled) {
                button.addEventListener('click', function(e) {
                    e.preventDefault();
                    const playerName = this.getAttribute('data-player');
                    
                    // Compiliamo il form del modal di segnalazione
                    const searchGonePlayer = document.getElementById('search-gone-player');
                    
                    if (searchGonePlayer) {
                        searchGonePlayer.value = playerName;
                        
                        // Mostriamo il modal
                        const searchGoneModal = document.getElementById('search-gone-modal');
                        if (searchGoneModal) {
                            searchGoneModal.classList.add('active');
                            document.body.classList.add('modal-open');
                        } else {
                            console.error('Modal di segnalazione non trovato');
                        }
                    } else {
                        console.error('Campo del form di segnalazione non trovato');
                    }
                });
            }
        });
    }
    
    // Editor JSON
    document.getElementById('load-json').addEventListener('click', function() {
        const jsonEditor = document.getElementById('json-editor');
        jsonEditor.value = JSON.stringify(state, null, 4);
        showNotification("JSON caricato nell'editor!");
    });
    
    document.getElementById('save-json').addEventListener('click', function() {
        const jsonEditor = document.getElementById('json-editor');
        try {
            const newState = JSON.parse(jsonEditor.value);
            
            // Validazione base
            if (!newState.budgetTotale || !newState.ruoliTarget) {
                throw new Error("JSON non valido: mancano campi obbligatori");
            }
            
            // Aggiorna lo stato
            state = newState;
            saveState();
            updateUI();
            showNotification("Stato aggiornato con successo!");
        } catch (error) {
            showNotification(`Errore nel parsing del JSON: ${error.message}`, true);
        }
    });
});
