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
const gameState = { started: false, playerOrder: [], currentTurn: null };

// Roles
const roles = ['Sheriff', 'Renegade', 'Outlaw', 'Outlaw', 'Deputy', 'Outlaw', 'Deputy', 'Renegade'];

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
    health: 8, 
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
    io.to(id).emit('assignRole', { id, role: rolesForGame[index] });
  });

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

// Dice Roll
socket.on('rollDice', () => {
  if (socket.id !== gameState.currentTurn) {
    socket.emit('gameError', 'It is not your turn to roll the dice.');
    return;
  }

  const diceResult = Math.floor(Math.random() * 6) + 1;
  console.log(`🎲 Dice rolled by ${players[socket.id].name}: ${diceResult}`);
  io.emit('diceResult', { player: players[socket.id].name, result: diceResult });

  // Move to the next player's turn
  const currentIndex = gameState.playerOrder.indexOf(gameState.currentTurn);
  const nextIndex = (currentIndex + 1) % gameState.playerOrder.length;
  gameState.currentTurn = gameState.playerOrder[nextIndex];

  // Notify all players of the new turn
  io.emit('updateTurn', gameState.currentTurn);
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