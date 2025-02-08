const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Enable CORS for all routes
app.use(cors());

const io = new Server(server, {
  cors: {
    origin: 'http://localhost:5173',
    methods: ['GET', 'POST']
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

const PORT = process.env.PORT || 3000;

// Add constants first
const TOTAL_ARROWS = 9;
const ARROW_SYMBOL = '🏹';
const DYNAMITE_SYMBOL = '💣';
const PLAYER_BASE_HEALTH = 8;
const SHERIFF_EXTRA_HEALTH = 2;
const QUESTION_MARK_SYMBOL = '❓';
const GUN_SYMBOL = '🔫';
const players = {}; // { socketId: { name, role, health, arrows, isAlive } }
const gameState = { 
  started: false,
  playerOrder: [],  
  currentTurn: null,
  diceStates: {},
  rerollsLeft: 3,  // Add initial rerolls count
  currentDice: [],  // Add this to track current dice
  resolvedDynamites: 0,  // Add counter for resolved dynamites
  dynamiteDamageDealt: false,  // Add this flag
  arrowsOnBoard: TOTAL_ARROWS,  // Track remaining arrows
};
const diceSymbols = ['1', '2', '🏹', '💣', '🍺', '🔫']; // Emojis for dice symbols

// Roles
const roles = ['Sheriff', 'Renegade', 'Outlaw', 'Outlaw', 'Deputy', 'Outlaw', 'Deputy', 'Renegade'];

// Serve a basic response
app.get('/', (req, res) => {
  res.send('Bang! The Dice Game server is running.');
});

// Helper Functions (move these before socket handlers)
const shuffleArray = (array) => {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
};

const checkAllDiceResolved = (states) => {
  return Object.values(states).every(state => state === 'resolved');
};

const countTotalDynamites = (dice) => {
  return dice.filter(value => value === DYNAMITE_SYMBOL).length;
};

const onlyDynamitesLeftToResolve = (dice, states) => {
  const unresolved = Object.entries(states)
    .filter(([_, state]) => state !== 'resolved');
  const unresolvedDynamites = unresolved
    .filter(([index]) => dice[index] === DYNAMITE_SYMBOL);
  return unresolvedDynamites.length > 0 && 
         unresolvedDynamites.length === unresolved.length;
};

const autoResolveDynamites = (dice, states) => {
  const newStates = { ...states };
  dice.forEach((value, index) => {
    if (value === DYNAMITE_SYMBOL && newStates[index] === 'kept') {
      newStates[index] = 'resolved';
    }
  });
  return newStates;
};

const updatePlayerHealth = (playerId, change) => {
  const player = players[playerId];
  if (!player) {
    console.log(`Cannot update health`);
    return false;
  }
  console.log(`Updating health for ${player.name} (${playerId}) by ${change}`);
  const newHealth = Math.min(Math.max(0, player.health + change), player.maxHealth);
  player.health = newHealth;
  player.isAlive = newHealth > 0;
  broadcastHealthUpdates(io);
  emitGameLog(io, `${player.name}'s health changed by ${change} (now: ${newHealth})`);
  
  return true;
};

const broadcastHealthUpdates = (io) => {
  const healthData = Object.values(players).map(player => ({
    socketId: player.socketId,
    health: player.health,
    maxHealth: player.maxHealth
  }));
  io.emit('updateHealth', healthData);
};

// Add helper function to count resolved dynamites
const countResolvedDynamites = (dice, states) => {
  return Object.entries(states).filter(([index, state]) => 
    state === 'resolved' && dice[index] === DYNAMITE_SYMBOL
  ).length;
};

// Add helper function to check if turn should end due to dynamites
const checkDynamiteEnd = (dice, states) => {
  const dynamiteCount = Object.entries(states).filter(([index, state]) => 
    dice[index] === DYNAMITE_SYMBOL && state === 'resolved'
  ).length;
  return dynamiteCount >= 3;
};

// Update the arrow handling function to only count newly rolled arrows
const handleArrowRoll = (dice, states, playerId) => {
  // Only count arrows from newly rolled dice (not kept or resolved)
  const arrowCount = dice.reduce((count, die, index) => {
    if (die === ARROW_SYMBOL && states[index] === 'rolled') {
      return count + 1;
    }
    return count;
  }, 0);

  if (arrowCount === 0) return;

  console.log(`Processing ${arrowCount} new arrows for player ${playerId}`);

  // Count how many arrows will trigger indian attack
  const arrowsUntilEmpty = Math.min(arrowCount, gameState.arrowsOnBoard);
  // Add arrows to current player
  players[playerId].arrows += arrowsUntilEmpty;
  gameState.arrowsOnBoard -= arrowsUntilEmpty;

  // Check if Indian Attack should trigger
  if (gameState.arrowsOnBoard === 0) {
    // Deal damage based on arrows
    Object.values(players).forEach(player => {
      if (player.arrows > 0) {
        updatePlayerHealth(player.socketId, -player.arrows);
        player.arrows = 0;  // Reset arrows after damage
      }
    });
    // Reset board arrows
    gameState.arrowsOnBoard = TOTAL_ARROWS;
  }

  // Handle remaining arrows from current roll
  const remainingArrows = arrowCount - arrowsUntilEmpty;
  if (remainingArrows > 0) {
    players[playerId].arrows += Math.min(remainingArrows, TOTAL_ARROWS);
    gameState.arrowsOnBoard -= Math.min(remainingArrows, TOTAL_ARROWS);
  }

  broadcastArrowState();
};

// Add broadcast function for arrow updates
const broadcastArrowState = () => {
  io.emit('arrowUpdate', {
    arrowsOnBoard: gameState.arrowsOnBoard,
    playerArrows: Object.entries(players).map(([id, player]) => ({
      socketId: id,
      arrows: player.arrows
    }))
  });
};

// Add helper function for game logging
const emitGameLog = (io, message) => {
  io.emit('gameLog', message);
};

// Add new helper function to check for gatling condition
const checkGatlingAvailable = (dice, states) => {
  const keptGuns = Object.entries(states).filter(([index, state]) => 
    dice[index] === GUN_SYMBOL && state === 'kept'
  ).length;
  return keptGuns >= 3;
};

// Update the handleGatling function to ensure it only uses exactly 3 guns when resolving a gatling
const handleGatling = (playerId, dice, states) => {
  // Find indices of all kept gun dice in order of appearance
  const keptGunIndices = Object.entries(dice)
    .map(([index, value], originalIndex) => ({ index: Number(index), value, originalIndex }))
    .filter(({ index, value }) => 
      value === GUN_SYMBOL && states[index] === 'kept'
    )
    .sort((a, b) => a.originalIndex - b.originalIndex) // Sort by original order
    .map(({ index }) => index)
    .slice(0, 2);  // Take exactly first 3 guns

  // Create new states object with resolved guns
  const newStates = { ...states };
  keptGunIndices.forEach(index => {
    newStates[index] = 'resolved';
  });

  // Deal damage to all other players
  Object.values(players).forEach(player => {
    if (player.socketId !== playerId && player.isAlive) {
      updatePlayerHealth(player.socketId, -1);
    }
  });

  // Return arrows to the pile
  if (players[playerId].arrows > 0) {
    gameState.arrowsOnBoard += players[playerId].arrows;
    players[playerId].arrows = 0;
    broadcastArrowState();
    emitGameLog(io, `${players[playerId].name} returned all arrows to the pile`);
  }

  return newStates;
};

// Handle Socket.io connections
io.on('connection', (socket) => {
  console.log(`🔌 A user connected: ${socket.id}`);
  
  // Test emit to confirm connection
  socket.emit('testConnection', 'You are connected to the server!');

  // Join Game
  socket.on('joinGame', (playerName) => {
    players[socket.id] = { 
      name: playerName,
      role: null,
      health: PLAYER_BASE_HEALTH,
      maxHealth: PLAYER_BASE_HEALTH, // Store max health
      arrows: 0,  // Initialize arrow count
      isAlive: true,
      socketId: socket.id // Add socket.id to the player object
    };
    console.log(`🎮 ${playerName} joined the game.`);
    io.emit('playerListUpdate', Object.values(players));
  });

  // Start Game & Assign Roles
  socket.on('startGame', () => {
    if (Object.keys(players).length < 4) {
      io.emit('gameError', 'Need at least 4 players to start the game.');
      return;
    }

    const numPlayers = Object.keys(players).length;

    // Slice the roles array to the number of players
    const rolesForGame = roles.slice(0, numPlayers);

    // Shuffle only the sliced roles
    for (let i = rolesForGame.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rolesForGame[i], rolesForGame[j]] = [rolesForGame[j], rolesForGame[i]];
    }

    Object.keys(players).forEach((id, index) => {
      players[id].role = rolesForGame[index];
      // If player is Sheriff, add extra health
      if (rolesForGame[index] === 'Sheriff') {
        players[id].health += SHERIFF_EXTRA_HEALTH;
        players[id].maxHealth += SHERIFF_EXTRA_HEALTH;
      }
      io.to(id).emit('assignRole', { 
        id, 
        role: rolesForGame[index]
      });
    });

    // Broadcast initial health states to all players
    broadcastHealthUpdates(io);

    gameState.started = true;

    // Convert players object to an array and shuffle it
    const playersArray = Object.values(players);
    const shuffledPlayers = shuffleArray(playersArray);

    // Update playerOrder with the shuffled order
    gameState.playerOrder = shuffledPlayers.map((player) => player.socketId);

    // Find the Sheriff and set them as the current turn
    const sheriff = shuffledPlayers.find((player) => player.role === 'Sheriff');
    if (sheriff) {
      gameState.currentTurn = sheriff.socketId;
    } else {
      // Fallback: If no Sheriff is found, use the first player
      gameState.currentTurn = gameState.playerOrder[0];
    }

    // Notify all players of the current turn and game start
    io.emit('updateTurn', gameState.currentTurn);
    io.emit('gameStarted', shuffledPlayers); // Send the shuffled players array to all clients
  });

  // Modify the rollDice handler
  socket.on('rollDice', (keptDiceData = {}) => {
    if (socket.id !== gameState.currentTurn) {
      socket.emit('gameError', 'It is not your turn to roll the dice.');
      return;
    }

    // Check rerolls and dynamites before proceeding
    if (gameState.rerollsLeft <= 0 || checkDynamiteEnd(gameState.currentDice, gameState.diceStates)) {
      socket.emit('gameError', 'Cannot roll - either no rerolls left or dynamites exploded!');
      return;
    }

    // Decrease rerolls first
    gameState.rerollsLeft--;

    const diceResult = [];
    const newDiceStates = {};
    
    // Log kept dice if any
    if (Object.keys(keptDiceData.dice).length > 0) {
      const keptDiceSymbols = Object.values(keptDiceData.dice).join(' ');
      emitGameLog(io, `${players[socket.id].name} kept: ${keptDiceSymbols}`);
    }

    // Handle kept dice first
    Object.entries(keptDiceData.dice).forEach(([index, value]) => {
      diceResult.push(value);
      newDiceStates[diceResult.length - 1] = keptDiceData.states[index];
    });

    // Add new rolled dice
    const numNewDice = 6 - diceResult.length;
    for (let i = 0; i < numNewDice; i++) {
      const randomIndex = Math.floor(Math.random() * diceSymbols.length);
      const rolledValue = diceSymbols[randomIndex];
      diceResult.push(rolledValue);
      
      // Automatically resolve dynamites
      newDiceStates[diceResult.length - 1] = rolledValue === DYNAMITE_SYMBOL ? 'resolved' : 'rolled';
    }

    // Log new roll
    const newDiceSymbols = diceResult.filter((_, i) => newDiceStates[i] === 'rolled').join(' ');
    emitGameLog(io, `${players[socket.id].name} rolled: ${newDiceSymbols}`);

    // Store current dice state
    gameState.currentDice = diceResult;
    gameState.diceStates = newDiceStates;

    // Handle arrows right after rolling, passing the new dice states
    handleArrowRoll(diceResult, newDiceStates, socket.id);

    // Check dynamite damage only if not already dealt this turn
    if (!gameState.dynamiteDamageDealt && countResolvedDynamites(diceResult, newDiceStates) >= 3) {
      updatePlayerHealth(gameState.currentTurn, -1);
      gameState.dynamiteDamageDealt = true;
      gameState.rerollsLeft = 0; // Force end of rolling
      emitGameLog(io, `💥 ${players[socket.id].name} was hit by dynamite explosion!`);
    }

    // Emit updated game state
    io.emit('diceResult', {
      dice: diceResult,
      states: newDiceStates,
      currentPlayer: socket.id,
      rerollsLeft: gameState.rerollsLeft
    });

    // Check if turn should end (all dice resolved and no rerolls left)
    if (gameState.rerollsLeft === 0 && checkAllDiceResolved(gameState.diceStates)) {
      progressToNextTurn(io);
    }
  });

  // Simplified dice selection update handler
  socket.on('updateKeptDice', (data) => {
    if (socket.id !== gameState.currentTurn) {
      socket.emit('gameError', 'It is not your turn to manage dice.');
      return;
    }

    io.emit('keptDiceUpdate', {
      indices: data.indices,
      currentPlayer: socket.id
    });
  });

  // Add state reset to end turn handler
  socket.on('endTurn', () => {
    if (socket.id !== gameState.currentTurn) return;
    progressToNextTurn(io);
  });

  // Simplify updateDiceStates handler
  socket.on('updateDiceStates', (data) => {
    if (socket.id !== gameState.currentTurn) {
      socket.emit('gameError', 'It is not your turn to manage dice.');
      return;
    }

    let newStates = { ...gameState.diceStates, ...data.states };

    // Check if this update includes resolving a gun and if gatling is available
    const isResolvingGun = Object.entries(data.states).some(([index, state]) => 
      gameState.currentDice[index] === GUN_SYMBOL && state === 'resolved'
    );

    if (isResolvingGun && checkGatlingAvailable(gameState.currentDice, gameState.diceStates)) {
      newStates = handleGatling(socket.id, gameState.currentDice, newStates);
      emitGameLog(io, `💥 ${players[socket.id].name} fired the Gatling Gun!`);
    }

    gameState.diceStates = newStates;

    // Only check if we need to end rolling
    if (countResolvedDynamites(gameState.currentDice, newStates) >= 3) {
      gameState.rerollsLeft = 0;
    }

    io.emit('diceStateUpdate', {
      states: newStates,
      currentPlayer: socket.id
    });

    if (checkAllDiceResolved(newStates)) {
      progressToNextTurn(io);
    }
  });

  // Disconnect Handling
  socket.on('disconnect', () => {
    console.log(`❌ User disconnected: ${socket.id}`);
    delete players[socket.id];
    io.emit('playerListUpdate', Object.values(players));
  });
});

// Start the server
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

// Simplify helper functions
const progressToNextTurn = (io) => {
  gameState.diceStates = {};
  gameState.rerollsLeft = 3; // Reset to initial value
  gameState.currentDice = [];
  gameState.resolvedDynamites = 0;  // Reset dynamite counter
  gameState.dynamiteDamageDealt = false;  // Reset the flag for new turn
  
  // Find next player's turn
  const currentIndex = gameState.playerOrder.indexOf(gameState.currentTurn);
  const nextIndex = (currentIndex + 1) % gameState.playerOrder.length;
  gameState.currentTurn = gameState.playerOrder[nextIndex];

  // Initialize all dice as question marks with 'initial' state
  const initialDice = Array(6).fill(QUESTION_MARK_SYMBOL);
  const initialStates = {};
  
  // Set all dice to 'initial' state
  for (let i = 0; i < 6; i++) {
    initialStates[i] = 'initial';
  }

  gameState.diceStates = initialStates;
  gameState.currentDice = initialDice;
  broadcastArrowState();

  const nextPlayer = players[gameState.playerOrder[nextIndex]];
  emitGameLog(io, `🎲 Turn changed to ${nextPlayer.name}`);
  
  io.emit('updateTurn', gameState.currentTurn);
  io.emit('diceResult', {
    dice: initialDice,
    states: initialStates,
    currentPlayer: gameState.currentTurn,
    rerollsLeft: gameState.rerollsLeft
  });
};