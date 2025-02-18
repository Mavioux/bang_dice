import { useState, useEffect } from 'react';
import io from 'socket.io-client';
import './styles.css';

// Initialize socket without connecting
let socket;

const DICE_STATES = {
  INITIAL: 'initial',
  ROLLED: 'rolled',
  KEPT: 'kept',
  RESOLVED: 'resolved'
};

// Updated reorderPlayers: filter out dead players and log them.
const reorderPlayers = (players, currentPlayerId) => {
  const alivePlayers = players.filter(player => player.isAlive);
  const deadPlayers = players.filter(player => !player.isAlive);
  if (deadPlayers.length > 0) {
    console.log('[GameLog] Eliminated players (ignored in order):', deadPlayers.map(p => ({ name: p.name, role: p.role })));
  }
  const currentPlayerIndex = alivePlayers.findIndex(player => player.socketId === currentPlayerId);
  if (currentPlayerIndex === -1) return alivePlayers; // fallback if current player not found
  const numPlayers = alivePlayers.length;
  const half = Math.floor(numPlayers / 2);
  const reorderedPlayers = [];
  for (let i = 0; i < numPlayers; i++) {
    const index = (currentPlayerIndex + half + i + numPlayers) % numPlayers;
    reorderedPlayers.push(alivePlayers[index]);
  }
  return reorderedPlayers;
};

const logPlayersOrder = (players) => {
  console.log('Frontend Players Order:', players.map(p => ({
    name: p.name,
    id: p.socketId,
    isAlive: p.isAlive,
    health: p.health
  })));
};

// Dice symbols and emojis
const diceSymbols = ['1', '2', '🏹', '💣', '🍺', '🔫'];

export default function App() {
  // Extract room ID outside of useEffect
  const path = window.location.pathname;
  const roomMatch = path.match(/^\/room\/([^/]+)/);
  const isInRoom = !!roomMatch;
  const roomId = roomMatch ? roomMatch[1] : null;

  // All state declarations must be before any conditional returns
  const [connected, setConnected] = useState(false);
  const [playerName, setPlayerName] = useState('');
  const [players, setPlayers] = useState([]);
  const [role, setRole] = useState(null);
  const [gameStarted, setGameStarted] = useState(false);
  const [diceResult, setDiceResult] = useState([]); // Current dice result
  const [keptDice, setKeptDice] = useState([]); // Dice the player has chosen to keep
  const [rerollsLeft, setRerollsLeft] = useState(3); // Changed from 2 to 3
  const [currentTurn, setCurrentTurn] = useState(null);
  const [arrowsInPlay, setArrowsInPlay] = useState(0);
  const [indianAttackActive, setIndianAttackActive] = useState(false);
  const [keptIndices, setKeptIndices] = useState(new Set()); // Indices of kept dice
  const [diceStates, setDiceStates] = useState({}); // Maps dice index to its state
  const [boardArrows, setBoardArrows] = useState(9);
  const [playerArrows, setPlayerArrows] = useState({});
  const [gameLog, setGameLog] = useState([]);
  const [selectedBeerTarget, setSelectedBeerTarget] = useState(null);
  const [isResolvingBeer, setIsResolvingBeer] = useState(false);
  const [isTargeting, setIsTargeting] = useState(false);
  const [targetDistance, setTargetDistance] = useState(null);

  const navigateToRoom = (roomId) => {
    window.location.href = `/room/${roomId}`;
  };

  // Handle create room
  const handleCreateRoom = () => {
    // Generate random room ID (you can adjust the length)
    const randomRoomId = Math.random().toString(36).substring(2, 8);
    navigateToRoom(randomRoomId);
  };

  // Handle join room
  const handleJoinRoom = (e) => {
    e.preventDefault();
    const roomId = e.target.roomId.value.trim();
    if (roomId) {
      navigateToRoom(roomId);
    }
  };

  // Add copy to clipboard function
  const copyRoomId = () => {
    navigator.clipboard.writeText(roomId);
    alert('Room ID copied to clipboard!');
  };

  // Main socket effect - now with proper conditional logic inside
  useEffect(() => {
    if (!isInRoom) return;

    // Initialize socket connection with relative URL
    socket = io({
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    socket.on('connect', () => {
      console.log('Connected to server');
      socket.emit('joinRoom', roomId);
    });

    socket.on('roomJoined', (roomId) => {
      console.log(`Joined room: ${roomId}`);
      setConnected(true);
    });

    const handlers = {
      playerListUpdate: (updatedPlayers) => {
        setPlayers(updatedPlayers);
        logPlayersOrder(updatedPlayers);  // Log when players update
      },
      assignRole: (data) => setRole(data.role),
      gameStarted: (players) => {
        setGameStarted(true);
        setPlayers(players);
      },
      updateTurn: (currentTurn) => {
        setCurrentTurn(currentTurn);
        // Reset dice state for new turn
        setKeptDice([]);
        setKeptIndices(new Set());
        setRerollsLeft(3);
        setDiceStates({});
      },
      diceResult: (data) => {
        setDiceResult(data.dice);
        setDiceStates(data.states);
        setRerollsLeft(data.rerollsLeft);
      },
      diceStateUpdate: (data) => setDiceStates(data.states),
      updateHealth: (healthData) => {
        setPlayers(currentPlayers =>
          currentPlayers.map(player => {
            // Find corresponding health update
            const update = healthData.find(data => data.socketId === player.socketId);
            return update ? { ...player, health: update.health, maxHealth: update.maxHealth, isAlive: update.isAlive } : player;
          })
        );
      },
      arrowUpdate: (data) => {
        setBoardArrows(data.arrowsOnBoard);
        const arrowMap = {};
        data.playerArrows.forEach(({ socketId, arrows }) => {
          arrowMap[socketId] = arrows;
        });
        setPlayerArrows(arrowMap);
      },
      gameLog: (message) => {
        setGameLog(prevLog => {
          const newEntry = {
            id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            message,
            timestamp: new Date().toLocaleTimeString()
          };
          return [...prevLog, newEntry];
        });
      }
    };

    // Register all handlers
    Object.entries(handlers).forEach(([event, handler]) => {
      socket.on(event, handler);
    });

    // Cleanup
    return () => {
      if (socket) socket.disconnect();
      Object.keys(handlers).forEach(event => {
        socket.off(event);
      });
    };
  }, [isInRoom, roomId]); // Add proper dependencies

  // Other useEffect hooks must also be before any conditional returns
  useEffect(() => {
    if (!socket) return;
    // Add useEffect to handle auto-resolution of dynamites
    if (rerollsLeft === 0 && diceResult.length > 0) {
      const newDiceStates = { ...diceStates };
      let statesChanged = false;

      diceResult.forEach((dice, index) => {
        if (dice === DYNAMITE_SYMBOL && newDiceStates[index] === DICE_STATES.KEPT) {
          newDiceStates[index] = DICE_STATES.RESOLVED;
          statesChanged = true;
        }
      });

      if (statesChanged) {
        setDiceStates(newDiceStates);
        socket.emit('updateDiceStates', {
          states: newDiceStates
        });
      }
    }
  }, [rerollsLeft, diceResult, diceStates]);

  useEffect(() => {
    if (!socket) return;
    const handleConnect = () => {
      console.log('Connected to server');
    };

    const handleDisconnect = () => {
      console.log('Disconnected from server');
    };

    const handleReconnect = () => {
      console.log('Reconnected to server');
      // Refresh game state if needed
      if (gameStarted) {
        socket.emit('requestGameState');
      }
    };

    const handleError = (error) => {
      console.error('Socket error:', error);
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('reconnect', handleReconnect);
    socket.on('error', handleError);

    // Add this new handler
    socket.on('connect_error', (error) => {
      console.log('Connection error:', error);
    });

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('reconnect', handleReconnect);
      socket.off('error', handleError);
      socket.off('connect_error');
    };
  }, [gameStarted]);

  // Now handle the conditional rendering
  if (!isInRoom) {
    return (
      <div className="app-container">
        <div className="landing-container">
          <h1>Welcome to Bang! The Dice Game</h1>
          <div className="landing-buttons">
            <button onClick={handleCreateRoom} className="button create-button">
              Create a Room
            </button>
            <div className="join-form">
              <form onSubmit={handleJoinRoom}>
                <input
                  type="text"
                  name="roomId"
                  placeholder="Enter Room ID"
                  className="input-field"
                />
                <button type="submit" className="button join-button">
                  Join Room
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="app-container">
        <h1>Connecting...</h1>
      </div>
    );
  }

  const joinGame = () => {
    if (playerName.trim() !== '') {
      socket.emit('joinGame', playerName);
    }
  };

  const startGame = () => {
    socket.emit('startGame');
  };

  const rollDice = () => {
    if (socket.id !== currentTurn) return;
    if (rerollsLeft === 0) {
      alert('No rerolls left!');
      return;
    }

    const keptDiceData = {
      dice: {},      
      states: {}     
    };

    // Store both dice values and their states
    diceResult.forEach((dice, index) => {
      if (index < 5 && (diceStates[index] === DICE_STATES.KEPT || diceStates[index] === DICE_STATES.RESOLVED)) {
        keptDiceData.dice[index] = dice;
        keptDiceData.states[index] = diceStates[index];
      }
    });

    console.log('Sending kept dice:', keptDiceData);
    socket.emit('rollDice', keptDiceData);
  };

  const DYNAMITE_SYMBOL = '💣';

  // Add new helper function to check for gatling
  const checkGatlingAvailable = (dice, states) => {
    const keptGuns = Object.entries(states).filter(([index, state]) => 
      dice[index] === '🔫' && state === DICE_STATES.KEPT
    ).length;
    return keptGuns >= 3;
  };

  // Add new handler for beer resolution
  const handleBeerResolution = (targetPlayerId) => {
    if (!isResolvingBeer || socket.id !== currentTurn) return;

    // Find the first kept beer die
    const beerIndex = diceResult.findIndex((dice, index) => 
      dice === '🍺' && diceStates[index] === DICE_STATES.KEPT
    );

    if (beerIndex === -1) return;

    // Update dice state and notify server
    const newDiceStates = {
      ...diceStates,
      [beerIndex]: DICE_STATES.RESOLVED
    };

    setDiceStates(newDiceStates);
    socket.emit('resolveBeer', { 
      targetPlayerId,
      diceIndex: beerIndex,
      newStates: newDiceStates
    });
    setIsResolvingBeer(false);
  };

  // Add helper to check for 3+ dynamites
  const hasThreeOrMoreDynamites = () => {
    return Object.entries(diceStates).filter(([index, state]) => 
      diceResult[index] === DYNAMITE_SYMBOL && state === 'resolved'
    ).length >= 3;
  };

  // Add helper to check if beer can be used
  const canUseBeer = diceResult.some((dice, index) => 
    dice === '🍺' && diceStates[index] === DICE_STATES.KEPT
  );

  // Add helper to check if a player can be healed
  const canHealPlayer = (player) => {
    return player.health < player.maxHealth;
  };

  // Replace the old getPlayerDistance with the updated version:
  const getPlayerDistance = (orderedPlayers, currentPlayerSocketId, targetIndex) => {
    const currentIndex = orderedPlayers.findIndex(p => p.socketId === currentPlayerSocketId);
    const clockwise = (targetIndex - currentIndex + orderedPlayers.length) % orderedPlayers.length;
    const counterClockwise = (currentIndex - targetIndex + orderedPlayers.length) % orderedPlayers.length;
    return Math.min(clockwise, counterClockwise);
  };

  // Update isPlayerTargetable to work with the ordered players array:
  const isPlayerTargetable = (player, index, orderedPlayers) => {
    if (!isTargeting || !player.isAlive || player.socketId === socket.id) return false;
    const distance = getPlayerDistance(orderedPlayers, socket.id, index);
    return distance === targetDistance;
  };

  // Add handler for shooting
  const handleShoot = (targetPlayerId) => {
    if (!isTargeting || socket.id !== currentTurn) return;
  
    // Find the first kept 1 or 2 die
    const shootIndex = diceResult.findIndex((dice, index) => 
      (dice === '1' || dice === '2') && diceStates[index] === DICE_STATES.KEPT
    );
  
    if (shootIndex === -1) return;
  
    // Update dice state and notify server
    const newDiceStates = {
      ...diceStates,
      [shootIndex]: DICE_STATES.RESOLVED
    };
  
    setDiceStates(newDiceStates);
    socket.emit('shoot', { 
      targetPlayerId,
      diceIndex: shootIndex,
      newStates: newDiceStates
    });
    setIsTargeting(false);
    setTargetDistance(null);
  };

  // Update the toggleDiceState function with fixed gun resolution logic
  const toggleDiceState = (index, reverse = false) => {
    if (socket.id !== currentTurn) return;
    if (diceStates[index] === DICE_STATES.INITIAL) return;
  
    const currentState = diceStates[index] || DICE_STATES.ROLLED;
    
    if (reverse) {
      if (currentState !== DICE_STATES.KEPT) return;
      const newDiceStates = {
        ...diceStates,
        [index]: DICE_STATES.ROLLED
      };
      setDiceStates(newDiceStates);
      socket.emit('updateDiceStates', { states: newDiceStates });
      return;
    }
  
    // Modified gun/targeting logic for kept dice
    if (currentState === DICE_STATES.KEPT) {
      if (diceResult[index] === '1') {
        setIsTargeting(true);
        setTargetDistance(1);
        return;
      }
      if (diceResult[index] === '2') {
        const aliveCount = players.filter(p => p.isAlive).length;
        if (aliveCount <= 3) {
          setIsTargeting(true);
          setTargetDistance(1); // Treat dice '2' as '1'
        } else {
          setIsTargeting(true);
          setTargetDistance(2);
        }
        return;
      }
    }
  
    // Modified state progression
    if (currentState === DICE_STATES.KEPT && diceResult[index] === '🍺') {
      setIsResolvingBeer(true);
      return;
    }

    if (currentState === DICE_STATES.KEPT) {
      if (diceResult[index] === '1') {
        setIsTargeting(true);
        setTargetDistance(1);
        return;
      }
      if (diceResult[index] === '2') {
        setIsTargeting(true);
        setTargetDistance(2);
        return;
      }
    }
  
    // Normal state progression
    let newState;
    switch (currentState) {
      case DICE_STATES.ROLLED:
        newState = DICE_STATES.KEPT;
        break;
      case DICE_STATES.KEPT:
        newState = DICE_STATES.RESOLVED;
        break;
      case DICE_STATES.RESOLVED:
        return;
      default:
        newState = DICE_STATES.ROLLED;
    }
  
    const newDiceStates = { 
      ...diceStates,
      [index]: newState 
    };
  
    setDiceStates(newDiceStates);
    socket.emit('updateDiceStates', { states: newDiceStates });
  };

  // Modify renderPlayerTile to accept the orderedPlayers array:
  const renderPlayerTile = (player, index, orderedPlayers) => {
    if (!player.isAlive) {
      return (
        <div
          key={index}
          className="player-tile dead"
        >
          <h4>{player.name}</h4>
          <div className="health-display">
            <span className="health-value">❤️ 0</span>
            <span className="health-max">({player.maxHealth})</span>
          </div>
          <p className="role-text">{player.role}</p>
          <p>💀 Eliminated</p>
        </div>
      );
    }
  
    return (
      <div
        key={index}
        className={`player-tile 
          ${player.socketId === currentTurn ? 'active' : ''} 
          ${player.socketId === socket.id ? 'current-player' : ''}
          ${isResolvingBeer ? 'healable' : ''}
          ${isPlayerTargetable(player, index, orderedPlayers) ? 'targetable' : ''}`}
        onClick={() => {
          if (isResolvingBeer) {
            handleBeerResolution(player.socketId);
          } else if (isPlayerTargetable(player, index, orderedPlayers)) {
            handleShoot(player.socketId);
          }
        }}
      >
        <h4>{player.name}</h4>
        <div className="health-display">
          <span className="health-value">❤️ {player.health}</span>
          <span className="health-max">({player.maxHealth})</span>
        </div>
        <div className="arrow-display">
          <span className="arrow-count">🏹 {playerArrows[player.socketId] || 0}</span>
        </div>
        {(player.socketId === socket.id || player.role === 'Sheriff') && (
          <p className="role-text">{player.role}</p>
        )}
      </div>
    );
  };

  // Update the GameLog component
  const GameLog = () => (
    <div className="game-log">
      <h3>Game Log</h3>
      <div className="log-entries">
        <div className="log-content">
          {[...gameLog].reverse().map(entry => (
            <div key={entry.id} className="log-entry">
              <span className="log-time">[{entry.timestamp}]</span>
              <span className="log-message">{entry.message}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  // Add visual indicator for available gatling
  const renderDice = (dice, index) => (
    <div key={index} className="dice-container">
      <div
        className={`dice ${diceStates[index]} ${
          dice === '🔫' && 
          diceStates[index] === DICE_STATES.KEPT && 
          checkGatlingAvailable(diceResult, diceStates) ? 'gatling-ready' : ''
        }`}
        onClick={() => socket.id === currentTurn && diceStates[index] !== DICE_STATES.INITIAL && toggleDiceState(index)}
        style={{ cursor: socket.id === currentTurn && diceStates[index] !== DICE_STATES.INITIAL ? 'pointer' : 'default' }}
      >
        {dice}
      </div>
      {/* Only show reverse button for non-dynamite kept dice */}
      {diceStates[index] === DICE_STATES.KEPT && 
      dice !== DYNAMITE_SYMBOL && 
      socket.id === currentTurn && (
        <button
          className="reverse-button"
          onClick={(e) => {
            e.stopPropagation();
            toggleDiceState(index, true);
          }}
          title="Reverse to rolled state"
        >
          ↩️
        </button>
      )}
    </div>
  );

  return (
    <div className={`app-container ${gameStarted ? 'game-started' : ''}`}>
      {!gameStarted ? (
        <div className="lobby-container">
          <h1 className="title">🎲 Bang! The Dice Game 🎯</h1>
          {isInRoom && (
            <div className="room-id-display">
              <span>Room ID: {roomId}</span>
              <button onClick={copyRoomId} className="copy-button">
                📋 Copy
              </button>
            </div>
          )}
          <input
            type="text"
            placeholder="Enter your name"
            value={playerName}
            onChange={(e) => setPlayerName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                joinGame(); // Call the joinGame function when Enter is pressed
              }
            }}
            className="input-field"
          />
          <button onClick={joinGame} className="button join-button">
            Join Game
          </button>

          <h2>Players in Lobby:</h2>
          {players.length > 0 ? (
            <ul>
              {players.map((player, index) => (
                <li key={index}>{player.name}</li>
              ))}
            </ul>
          ) : (
            <p>No players in the lobby yet.</p>
          )}

          {players.length >= 4 && (
            <button onClick={startGame} className="button start-button">
              Start Game
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="game-container">
            {/* Remove the centered player name section */}
            
            {/* Player tiles */}
            <div className="player-tiles">
              {(() => {
                const orderedPlayers = reorderPlayers(players, socket.id);
                logPlayersOrder(orderedPlayers);  // Log whenever display order changes
                return orderedPlayers.map((player, index) =>
                  // Pass the orderedPlayers array to renderPlayerTile
                  renderPlayerTile(player, index, orderedPlayers)
                );
              })()}
            </div>

            {/* Dice Rolling Section */}
            <div className="dice-section">
              <h3>{socket.id === currentTurn ? 'Your Dice' : `${players.find(p => p.socketId === currentTurn)?.name}'s Dice`}</h3>
              <div className="dice-column">
                {diceResult.map((dice, index) => renderDice(dice, index))}
              </div>
              {socket.id === currentTurn && (
                <div className="dice-actions">
                  <button 
                    onClick={rollDice} 
                    disabled={rerollsLeft === 0 || hasThreeOrMoreDynamites()}
                  >
                    Roll ({rerollsLeft} rerolls left)
                    {hasThreeOrMoreDynamites() && ' - Dynamites Exploded!'}
                  </button>
                </div>
              )}
            </div>

            <div className="board-status"></div>
              <p className="arrows-on-board">
                Arrows on Board: {boardArrows}
              </p>
            </div>

            {arrowsInPlay > 0 && (
              <p>Arrows in Play: {arrowsInPlay}</p>
            )}
            {indianAttackActive && (
              <p className="indian-attack">⚠️ Indian Attack Active! ⚠️</p>
            )}
          </div>
          <GameLog />
        </>
      )}
    </div>
  );
}