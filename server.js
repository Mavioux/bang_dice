const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Enable CORS for all routes
app.use(cors());

// Serve static files from the React app
app.use(express.static(path.join(__dirname, 'bang_frontend/dist')));

// Initialize rooms storage
const rooms = new Map();

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
const BEER_SYMBOL = '🍺';
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
  res.send(`
    <html>
      <head>
        <title>Bang! The Dice Game</title>
        <style>
          body {
            background-color: #1a1a1a;
            color: #fff;
            font-family: Arial, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
          }
          .container {
            text-align: center;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Welcome to Bang! The Dice Game</h1>
          <p>Please use the React app to create or join a room</p>
        </div>
      </body>
    </html>
  `);
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

const updatePlayerHealth = (playerId, change, room) => {
  const player = room.players[playerId];
  if (!player) {
    console.log(`Cannot update health for player ${playerId}`);
    return false;
  }

  console.log(`Updating health for ${player.name} (${playerId}) by ${change}`);
  const newHealth = Math.min(Math.max(0, player.health + change), player.maxHealth);
  player.health = newHealth;
  player.isAlive = newHealth > 0;

  if (!player.isAlive) {
    emitGameLog(room, `💀 ${player.name} was eliminated!`);
    const playerIndex = room.gameState.playerOrder.indexOf(playerId);
    if (playerIndex !== -1) {
      room.gameState.playerOrder.splice(playerIndex, 1);
    }
    
    if (room.gameState.currentTurn === playerId) {
      progressToNextTurn(room);
    }
  }

  broadcastHealthUpdates(room);
  emitGameLog(room, `${player.name}'s health changed by ${change} (now: ${newHealth})`);
  
  return true;
};

const broadcastHealthUpdates = (room) => {
  const healthData = Object.values(room.players).map(player => ({
    socketId: player.socketId,
    health: player.health,
    maxHealth: player.maxHealth,
    isAlive: player.isAlive
  }));
  io.to(room.id).emit('updateHealth', healthData);
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
const handleArrowRoll = (dice, states, playerId, room) => {
  const arrowCount = dice.reduce((count, die, index) => {
    if (die === ARROW_SYMBOL && states[index] === 'rolled') {
      return count + 1;
    }
    return count;
  }, 0);

  if (arrowCount === 0) return;

  console.log(`Processing ${arrowCount} new arrows for player ${playerId}`);

  const arrowsUntilEmpty = Math.min(arrowCount, room.gameState.arrowsOnBoard);
  // Add arrows to current player
  room.players[playerId].arrows += arrowsUntilEmpty;
  room.gameState.arrowsOnBoard -= arrowsUntilEmpty;

  // Check if Indian Attack should trigger
  if (room.gameState.arrowsOnBoard === 0) {
    // Deal damage based on arrows
    Object.values(room.players).forEach(player => {
      if (player.arrows > 0) {
        updatePlayerHealth(player.socketId, -player.arrows, room);
        player.arrows = 0;
      }
    });
    // Reset board arrows
    room.gameState.arrowsOnBoard = TOTAL_ARROWS;
  }

  // Handle remaining arrows
  const remainingArrows = arrowCount - arrowsUntilEmpty;
  if (remainingArrows > 0) {
    room.players[playerId].arrows += Math.min(remainingArrows, TOTAL_ARROWS);
    room.gameState.arrowsOnBoard -= Math.min(remainingArrows, TOTAL_ARROWS);
  }

  broadcastArrowState(room);
};

// Add broadcast function for arrow updates
const broadcastArrowState = (room) => {
  io.to(room.id).emit('arrowUpdate', {
    arrowsOnBoard: room.gameState.arrowsOnBoard,
    playerArrows: Object.entries(room.players).map(([id, player]) => ({
      socketId: id,
      arrows: player.arrows
    }))
  });
};

// Add helper function for game logging
const emitGameLog = (room, message) => {
  io.to(room.id).emit('gameLog', message);
};

// Add new helper function to check for gatling condition
const checkGatlingAvailable = (dice, states) => {
  const keptGuns = Object.entries(states).filter(([index, state]) => 
    dice[index] === GUN_SYMBOL && state === 'kept'
  ).length;
  return keptGuns >= 3;
};

// Update the handleGatling function to ensure it only uses exactly 3 guns when resolving a gatling
const handleGatling = (playerId, dice, states, room) => {
  const newStates = { ...states };
  
  Object.entries(states).forEach(([index, state]) => {
    if (dice[index] === GUN_SYMBOL && state === 'kept') {
      newStates[index] = 'resolved';
    }
  });

  Object.values(room.players).forEach(player => {
    if (player.socketId !== playerId && player.isAlive) {
      updatePlayerHealth(player.socketId, -1, room);
    }
  });

  if (room.players[playerId].arrows > 0) {
    room.gameState.arrowsOnBoard += room.players[playerId].arrows;
    room.players[playerId].arrows = 0;
    broadcastArrowState(room);
    emitGameLog(room, `${room.players[playerId].name} returned all arrows to the pile`);
  }

  return newStates;
};

// Add room state initialization
const createNewRoom = (roomId) => ({
  id: roomId,
  players: {},
  gameState: {
    started: false,
    playerOrder: [],
    currentTurn: null,
    diceStates: {},
    rerollsLeft: 3,
    currentDice: [],
    resolvedDynamites: 0,
    dynamiteDamageDealt: false,
    arrowsOnBoard: TOTAL_ARROWS,
  }
});

// Handle Socket.io connections
io.on('connection', (socket) => {
  console.log(`🔌 A user connected: ${socket.id}`);
  let currentRoom = null;

  socket.on('joinRoom', (roomId) => {
    // Create room if it doesn't exist
    if (!rooms.has(roomId)) {
      rooms.set(roomId, createNewRoom(roomId));
    }
    
    // Join socket.io room
    socket.join(roomId);
    currentRoom = roomId;
    
    socket.emit('roomJoined', roomId);
  });

  // Modify existing event handlers to be room-aware
  socket.on('joinGame', (playerName) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    
    room.players[socket.id] = {
      name: playerName,
      role: null,
      health: PLAYER_BASE_HEALTH,
      maxHealth: PLAYER_BASE_HEALTH,
      arrows: 0,
      isAlive: true,
      socketId: socket.id
    };
    
    io.to(currentRoom).emit('playerListUpdate', Object.values(room.players));
  });

  // Start Game & Assign Roles
  socket.on('startGame', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    
    if (Object.keys(room.players).length < 4) {
      io.to(currentRoom).emit('gameError', 'Need at least 4 players to start the game.');
      return;
    }

    const numPlayers = Object.keys(room.players).length;

    // Slice the roles array to the number of players
    const rolesForGame = roles.slice(0, numPlayers);

    // Shuffle only the sliced roles
    for (let i = rolesForGame.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rolesForGame[i], rolesForGame[j]] = [rolesForGame[j], rolesForGame[i]];
    }

    Object.keys(room.players).forEach((id, index) => {
      room.players[id].role = rolesForGame[index];
      // If player is Sheriff, add extra health
      if (rolesForGame[index] === 'Sheriff') {
        room.players[id].health += SHERIFF_EXTRA_HEALTH;
        room.players[id].maxHealth += SHERIFF_EXTRA_HEALTH;
      }
      io.to(id).emit('assignRole', { 
        id, 
        role: rolesForGame[index]
      });
    });

    // Broadcast initial health states to all players
    broadcastHealthUpdates(room);

    room.gameState.started = true;

    // Convert players object to an array and shuffle it
    const playersArray = Object.values(room.players);
    const shuffledPlayers = shuffleArray(playersArray);

    // Update playerOrder with the shuffled order
    room.gameState.playerOrder = shuffledPlayers.map((player) => player.socketId);

    // Add debug logging
    console.log('Initial Player Order:', room.gameState.playerOrder.map(id => ({
      id,
      name: room.players[id].name
    })));

    // Find the Sheriff and set them as the current turn
    const sheriff = shuffledPlayers.find((player) => player.role === 'Sheriff');
    if (sheriff) {
      room.gameState.currentTurn = sheriff.socketId;
    } else {
      // Fallback: If no Sheriff is found, use the first player
      room.gameState.currentTurn = room.gameState.playerOrder[0];
    }

    // Notify all players of the current turn and game start
    io.to(currentRoom).emit('updateTurn', room.gameState.currentTurn);
    io.to(currentRoom).emit('gameStarted', shuffledPlayers); // Send the shuffled players array to all clients
  });

  // Modify the rollDice handler
  socket.on('rollDice', (keptDiceData = {}) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);

    if (socket.id !== room.gameState.currentTurn) {
      socket.emit('gameError', 'It is not your turn to roll the dice.');
      return;
    }

    // Check rerolls and dynamites before proceeding
    if (room.gameState.rerollsLeft <= 0 || checkDynamiteEnd(room.gameState.currentDice, room.gameState.diceStates)) {
      socket.emit('gameError', 'Cannot roll - either no rerolls left or dynamites exploded!');
      return;
    }

    // Decrease rerolls first
    room.gameState.rerollsLeft--;

    const diceResult = [];
    const newDiceStates = {};
    
    // Log kept dice if any
    if (Object.keys(keptDiceData.dice).length > 0) {
      const keptDiceSymbols = Object.values(keptDiceData.dice).join(' ');
      emitGameLog(room, `${room.players[socket.id].name} kept: ${keptDiceSymbols}`);
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
    emitGameLog(room, `${room.players[socket.id].name} rolled: ${newDiceSymbols}`);

    // Store current dice state
    room.gameState.currentDice = diceResult;
    room.gameState.diceStates = newDiceStates;

    // Handle arrows right after rolling, passing the new dice states
    handleArrowRoll(diceResult, newDiceStates, socket.id, room);

    // Check dynamite damage only if not already dealt this turn
    if (!room.gameState.dynamiteDamageDealt && countResolvedDynamites(diceResult, newDiceStates) >= 3) {
      updatePlayerHealth(room.gameState.currentTurn, -1, room);
      room.gameState.dynamiteDamageDealt = true;
      room.gameState.rerollsLeft = 0; // Force end of rolling
      emitGameLog(room, `💥 ${room.players[socket.id].name} was hit by dynamite explosion!`);
    }

    // Emit updated game state
    io.to(currentRoom).emit('diceResult', {
      dice: diceResult,
      states: newDiceStates,
      currentPlayer: socket.id,
      rerollsLeft: room.gameState.rerollsLeft
    });

    // Check if turn should end (all dice resolved and no rerolls left)
    if (room.gameState.rerollsLeft === 0 && checkAllDiceResolved(room.gameState.diceStates)) {
      progressToNextTurn(room);
    }
  });

  // Simplified dice selection update handler
  socket.on('updateKeptDice', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);

    if (socket.id !== room.gameState.currentTurn) {
      socket.emit('gameError', 'It is not your turn to manage dice.');
      return;
    }

    io.to(currentRoom).emit('keptDiceUpdate', {
      indices: data.indices,
      currentPlayer: socket.id
    });
  });

  // Add state reset to end turn handler
  socket.on('endTurn', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);

    if (socket.id !== room.gameState.currentTurn) return;
    progressToNextTurn(room);
  });

  // Simplify updateDiceStates handler
  socket.on('updateDiceStates', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);

    if (socket.id !== room.gameState.currentTurn) {
      socket.emit('gameError', 'It is not your turn to manage dice.');
      return;
    }

    let newStates = { ...room.gameState.diceStates, ...data.states };

    // Check if this update includes resolving a gun and if gatling is available
    const isResolvingGun = Object.entries(data.states).some(([index, state]) => 
      room.gameState.currentDice[index] === GUN_SYMBOL && state === 'resolved'
    );

    if (isResolvingGun && checkGatlingAvailable(room.gameState.currentDice, room.gameState.diceStates)) {
      newStates = handleGatling(socket.id, room.gameState.currentDice, newStates, room);
      emitGameLog(room, `💥 ${room.players[socket.id].name} fired the Gatling Gun!`);
    }

    room.gameState.diceStates = newStates;

    // Only check if we need to end rolling
    if (countResolvedDynamites(room.gameState.currentDice, newStates) >= 3) {
      room.gameState.rerollsLeft = 0;
    }

    io.to(currentRoom).emit('diceStateUpdate', {
      states: newStates,
      currentPlayer: socket.id
    });

    if (checkAllDiceResolved(newStates)) {
      progressToNextTurn(room);
    }
  });

  // Add new event handler inside io.on('connection', (socket) => {
  socket.on('resolveBeer', ({ targetPlayerId, diceIndex, newStates }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);

    if (socket.id !== room.gameState.currentTurn) {
      socket.emit('gameError', 'It is not your turn.');
      return;
    }

    const targetPlayer = room.players[targetPlayerId];
    if (!targetPlayer) {
      socket.emit('gameError', 'Invalid target player.');
      return;
    }

    // Update the dice states
    room.gameState.diceStates = newStates;

    // Try to heal the target player
    if (targetPlayer.health < targetPlayer.maxHealth) {
      updatePlayerHealth(targetPlayerId, 1, room);
      emitGameLog(room, `🍺 ${room.players[socket.id].name} healed ${targetPlayer.name}`);
    } else {
      emitGameLog(room, `🍺 ${room.players[socket.id].name} tried to heal ${targetPlayer.name, room}, but they were already at max health!`);
    }

    // Broadcast updated dice states
    io.to(currentRoom).emit('diceStateUpdate', {
      states: newStates,
      currentPlayer: socket.id
    });

    // Check if turn should end
    if (checkAllDiceResolved(newStates)) {
      progressToNextTurn(room);
    }
  });

  // Add new socket handler for shooting
  socket.on('shoot', ({ targetPlayerId, diceIndex, newStates }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);

    if (socket.id !== room.gameState.currentTurn) {
      socket.emit('gameError', 'It is not your turn.');
      return;
    }

    const targetPlayer = room.players[targetPlayerId];
    if (!targetPlayer) {
      socket.emit('gameError', 'Invalid target player.');
      return;
    }

    // Update the dice states
    room.gameState.diceStates = newStates;

    // Deal damage to target player
    updatePlayerHealth(targetPlayerId, -1, room);
    emitGameLog(room, `🎯 ${room.players[socket.id].name} shot ${targetPlayer.name}`);

    // Broadcast updated dice states
    io.to(currentRoom).emit('diceStateUpdate', {
      states: newStates,
      currentPlayer: socket.id
    });

    // Check if turn should end
    if (checkAllDiceResolved(newStates)) {
      progressToNextTurn(room);
    }
  });

  // Disconnect Handling
  socket.on('disconnect', () => {
    console.log(`❌ User disconnected: ${socket.id}`);
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      delete room.players[socket.id];
      
      // Remove room if empty
      if (Object.keys(room.players).length === 0) {
        rooms.delete(currentRoom);
      } else {
        io.to(currentRoom).emit('playerListUpdate', Object.values(room.players));
      }
    }
  });
});

// The catch-all handler - must be after all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'bang_frontend/dist/index.html'));
});

// Start the server
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

// Simplify helper functions
const progressToNextTurn = (room) => {
  room.gameState.diceStates = {};
  room.gameState.rerollsLeft = 3; // Reset to initial value
  room.gameState.currentDice = [];
  room.gameState.resolvedDynamites = 0;  // Reset dynamite counter
  room.gameState.dynamiteDamageDealt = false;  // Reset the flag for new turn
  
  // Find next player's turn
  const currentIndex = room.gameState.playerOrder.indexOf(room.gameState.currentTurn);
  const nextIndex = (currentIndex + 1) % room.gameState.playerOrder.length;
  room.gameState.currentTurn = room.gameState.playerOrder[nextIndex];

  // Initialize all dice as question marks with 'initial' state
  const initialDice = Array(6).fill(QUESTION_MARK_SYMBOL);
  const initialStates = {};
  
  // Set all dice to 'initial' state
  for (let i = 0; i < 6; i++) {
    initialStates[i] = 'initial';
  }

  room.gameState.diceStates = initialStates;
  room.gameState.currentDice = initialDice;
  broadcastArrowState(room);

  const nextPlayer = room.players[room.gameState.playerOrder[nextIndex]];
  emitGameLog(room, `🎲 Turn changed to ${nextPlayer.name}`);
  
  // Add debug logging
  console.log('Server Player Order:', room.gameState.playerOrder.map(id => ({
    id,
    name: room.players[id].name,
    isAlive: room.players[id].isAlive
  })));

  io.to(room.id).emit('updateTurn', room.gameState.currentTurn);
  io.to(room.id).emit('diceResult', {
    dice: initialDice,
    states: initialStates,
    currentPlayer: room.gameState.currentTurn,
    rerollsLeft: room.gameState.rerollsLeft
  });
};