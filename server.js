// server.js

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors'); // Import cors

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
    arrowsInPlay: 0, // Track arrows for Indian attacks
    indianAttackActive: false, // Track if an Indian attack is ongoing
};

// Dice
const diceSymbols = ['Bullet', 'Arrow', 'Dynamite', 'Beer', 'Gatling', 'DoubleBullet'];
const diceResult = diceSymbols[Math.floor(Math.random() * diceSymbols.length)];

// Roles
const roles = ['Sheriff', 'Renegade', 'Outlaw',  'Outlaw', 'Deputy', 'Outlaw', 'Deputy', 'Renegade'];

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
    players[socket.id] = { name: playerName, role: null, health: 8, arrows: 0, isAlive: true };
    console.log(`🎮 ${playerName} joined the game.`);
    io.emit('playerListUpdate', Object.values(players));
  });

  // Start Game & Assign Roles
  const roles = ['Sheriff', 'Renegade', 'Outlaw', 'Outlaw', 'Deputy', 'Outlaw', 'Deputy', 'Renegade'];

socket.on('startGame', () => {
  if (Object.keys(players).length < 4) {
    io.emit('gameError', 'Need at least 4 players to start the game.');
    return;
  }

  // Step 1: Slice the roles array based on the number of players
  const numPlayers = Object.keys(players).length;
  const rolesForGame = roles.slice(0, numPlayers); // Take the first N roles

  // Step 2: Shuffle the sliced roles array
  for (let i = rolesForGame.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rolesForGame[i], rolesForGame[j]] = [rolesForGame[j], rolesForGame[i]];
  }

  // Step 3: Assign roles to players
  Object.keys(players).forEach((id, index) => {
    players[id].role = rolesForGame[index];
    if (id === socket.id) {
      // Emit to the sender (player who started the game)
      socket.emit('assignRole', { id, role: rolesForGame[index] });
      console.log(`🎭 Assigned role to ${players[id].name}: ${rolesForGame[index]}`);
    } else {
      // Emit to other players
      socket.to(id).emit('assignRole', { id, role: rolesForGame[index] });
      console.log(`🎭 Assigned role to ${players[id].name}: ${rolesForGame[index]}`);
    }
  });

  // Update game state
  gameState.started = true;
  gameState.playerOrder = Object.keys(players);
  gameState.currentTurn = gameState.playerOrder[0];

  io.emit('gameStarted', players);
});

  // Dice Roll
  socket.on('rollDice', () => {
    if (socket.id !== gameState.currentTurn) return; // Only current player can roll

    const diceResult = Math.floor(Math.random() * 6) + 1;
    console.log(`🎲 Dice rolled by ${players[socket.id].name}: ${diceResult}`);
    io.emit('diceResult', { player: players[socket.id].name, result: diceResult });
  });

  // Player Action
  socket.on('playerAction', (action) => {
    const player = players[socket.id];
    if (action.type === 'shoot' && diceResult === 'Bullet') {
      // Handle shooting logic
    } else if (action.type === 'heal' && diceResult === 'Beer') {
      // Handle healing logic
    }
    io.emit('actionTaken', action);
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
