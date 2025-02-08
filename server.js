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
    origin: 'http://localhost:5173', // Replace with your frontend URL
    methods: ['GET', 'POST'],
  },
});

const PORT = process.env.PORT || 3000;

// Game data
const players = {}; // { socketId: { name, role, health, arrows, isAlive } }
const gameState = { 
  started: false, 
  playerOrder: [], 
  currentTurn: null,
  diceStates: {},
  rerollsLeft: 3,  // Add initial rerolls count
  currentDice: [],  // Add this to track current dice
  resolvedDynamites: 0  // Add counter for resolved dynamites
};
const diceSymbols = ['1', '2', '🏹', '💣', '🍺', '🔫']; // Emojis for dice symbols

// Add constant for dynamite symbol
const DYNAMITE_SYMBOL = '💣';

// Roles
const roles = ['Sheriff', 'Renegade', 'Outlaw', 'Outlaw', 'Deputy', 'Outlaw', 'Deputy', 'Renegade'];

const PLAYER_BASE_HEALTH = 8;
const SHERIFF_EXTRA_HEALTH = 2;

// Serve a basic response
app.get('/', (req, res) => {
  res.send('Bang! The Dice Game server is running.');
});

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
    arrows: 0, 
    isAlive: true, 
    socketId: socket.id // Add socket.id to the player object
  };
  console.log(`🎮 ${playerName} joined the game.`);
  io.emit('playerListUpdate', Object.values(players));
});

// Utility function to shuffle an array
const shuffleArray = (array) => {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
};

// Add new helper function near the top with other game logic
const checkAllDiceResolved = (states) => {
  return Object.values(states).every(state => state === 'resolved');
};

const progressToNextTurn = (io) => {
  gameState.diceStates = {};
  gameState.rerollsLeft = 3; // Reset to initial value
  gameState.currentDice = [];
  gameState.resolvedDynamites = 0;  // Reset dynamite counter
  
  // Find next player's turn
  const currentIndex = gameState.playerOrder.indexOf(gameState.currentTurn);
  const nextIndex = (currentIndex + 1) % gameState.playerOrder.length;
  gameState.currentTurn = gameState.playerOrder[nextIndex];
  
  // Roll initial dice for new player
  const initialDice = [];
  const initialStates = {};
  
  // Roll all 6 dice for the new player
  for (let i = 0; i < 6; i++) {
    const randomIndex = Math.floor(Math.random() * diceSymbols.length);
    initialDice.push(diceSymbols[randomIndex]);
    initialStates[i] = 'rolled';
  }

  // Update game state with initial dice
  gameState.diceStates = initialStates;

  // Emit turn update and initial dice roll
  io.emit('updateTurn', gameState.currentTurn);
  io.emit('diceResult', {
    dice: initialDice,
    states: initialStates,
    currentPlayer: gameState.currentTurn,
    rerollsLeft: gameState.rerollsLeft
  });
};

// Add new function to broadcast health updates
const broadcastHealthUpdates = (io) => {
  const healthData = Object.values(players).map(player => ({
    socketId: player.socketId,
    health: player.health,
    maxHealth: player.maxHealth
  }));
  io.emit('updateHealth', healthData);
};

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

  // Check rerolls before proceeding
  if (gameState.rerollsLeft <= 0) {
    socket.emit('gameError', 'No rerolls left for this turn.');
    return;
  }

  // Decrease rerolls first
  gameState.rerollsLeft--;

  const existingStates = gameState.diceStates;
  const newDiceStates = {};
  const diceResult = [];
  const originalIndices = {};
  
  // First, handle kept and resolved dice
  Object.entries(existingStates).forEach(([index, state]) => {
    if (state === 'kept' || state === 'resolved') {
      // Make sure we're accessing the correct dice value
      const diceValue = keptDiceData.dice[index];
      console.log('Keeping dice:', index, diceValue); // Debug log
      if (diceValue) {
        diceResult.push(diceValue);
        newDiceStates[diceResult.length - 1] = state;
        originalIndices[diceResult.length - 1] = parseInt(index);
      }
    }
  });

  // Then add new rolled dice
  const numNewDice = 6 - diceResult.length;
  for (let i = 0; i < numNewDice; i++) {
    const randomIndex = Math.floor(Math.random() * diceSymbols.length);
    const rolledValue = diceSymbols[randomIndex];
    diceResult.push(rolledValue);
    
    // Automatically keep dynamites (but don't resolve)
    newDiceStates[diceResult.length - 1] = rolledValue === DYNAMITE_SYMBOL ? 'kept' : 'rolled';
  }

  // Store the dice result in game state
  gameState.currentDice = diceResult;

  // Update game state
  gameState.diceStates = gameState.rerollsLeft === 0 
    ? autoResolveDynamites(diceResult, newDiceStates)
    : newDiceStates;

  io.emit('diceResult', {
    dice: diceResult,
    states: gameState.diceStates,
    originalIndices: originalIndices,
    currentPlayer: socket.id,
    rerollsLeft: gameState.rerollsLeft // Send updated rerolls count
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

// Add new handler for dice state updates
socket.on('updateDiceStates', (data) => {
  if (socket.id !== gameState.currentTurn) {
    socket.emit('gameError', 'It is not your turn to manage dice.');
    return;
  }

  // Validate that dynamites remain kept
  const currentStates = gameState.diceStates;
  const newStates = { ...currentStates, ...data.states };
  
  // Check each dice to ensure dynamites stay kept
  Object.entries(newStates).forEach(([index, state]) => {
    if (gameState.currentDice[index] === DYNAMITE_SYMBOL && 
        state !== 'kept' && 
        state !== 'resolved') {
      newStates[index] = 'kept';
    }
  });

  // Update game state with validated states
  gameState.diceStates = newStates;

  io.emit('diceStateUpdate', {
    states: newStates,
    currentPlayer: socket.id
  });

  // Check if all dice are resolved
  if (checkAllDiceResolved(gameState.diceStates)) {
    // Process any game effects here before changing turns
    // TODO: Add game logic for resolved dice effects

    // Progress to next turn
    progressToNextTurn(io);
  }
});

// Add helper function to auto-resolve dynamites
const autoResolveDynamites = (dice, states) => {
  const newStates = { ...states };
  dice.forEach((value, index) => {
    if (value === DYNAMITE_SYMBOL && newStates[index] === 'kept') {
      newStates[index] = 'resolved';
    }
  });
  return newStates;
};

// Add helper function for health management
const updatePlayerHealth = (playerId, change) => {
  const player = players[playerId];
  if (!player) {
    console.log(`Cannot Updating health`);
    return false;
  }

  console.log(`Updating health for ${player.name} (${playerId}) by ${change}`);

  const newHealth = Math.min(Math.max(0, player.health + change), player.maxHealth);
  player.health = newHealth;
  player.isAlive = newHealth > 0;

  // Broadcast updated health to all players
  broadcastHealthUpdates(io);
  return true;
};

// Add new helper function
const onlyDynamitesLeftToResolve = (dice, states) => {
  let hasUnresolvedDynamites = false;
  let hasOtherUnresolvedDice = false;

  Object.entries(states).forEach(([index, state]) => {
    const isDynamite = dice[index] === DYNAMITE_SYMBOL;
    const isKept = state === 'kept';
    const isResolved = state === 'resolved';

    if (isDynamite && isKept) {
      hasUnresolvedDynamites = true;
    } else if (!isResolved && (!isDynamite || !isKept)) {
      hasOtherUnresolvedDice = true;
    }
  });

  return hasUnresolvedDynamites && !hasOtherUnresolvedDice;
};

// Add helper function to count total dynamites
const countTotalDynamites = (dice, states) => {
  return dice.reduce((count, value, index) => {
    return value === DYNAMITE_SYMBOL ? count + 1 : count;
  }, 0);
};

// Update the updateDiceStates handler
socket.on('updateDiceStates', (data) => {
  if (socket.id !== gameState.currentTurn) {
    socket.emit('gameError', 'It is not your turn to manage dice.');
    return;
  }

  const currentStates = gameState.diceStates;
  const newStates = { ...currentStates, ...data.states };
  
  // Update game state
  gameState.diceStates = newStates;

  // Check total dynamites in play (regardless of state)
  const totalDynamites = countTotalDynamites(gameState.currentDice, newStates);
  console.log('Total dynamites:', totalDynamites);
  if (totalDynamites >= 3) {
    // Apply damage to current player
    updatePlayerHealth(gameState.currentTurn, -1);
    // Force end of rerolls
    gameState.rerollsLeft = 0;
  }

  // Emit state update
  io.emit('diceStateUpdate', {
    states: newStates,
    currentPlayer: socket.id
  });

  // Check if all dice are resolved
  if (checkAllDiceResolved(gameState.diceStates)) {
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