import { useState, useEffect } from 'react';
import io from 'socket.io-client';
import './styles.css';

const socket = io('http://localhost:3000');

const DICE_STATES = {
  ROLLED: 'rolled',
  KEPT: 'kept',
  RESOLVED: 'resolved'
};

// Utility function to reorder the players array so the current player is in the center
const reorderPlayers = (players, currentPlayerId) => {
  const currentPlayerIndex = players.findIndex((player) => player.socketId === currentPlayerId);
  if (currentPlayerIndex === -1) return players; // Fallback: return the original array if the current player is not found

  // Calculate the number of players before and after the current player
  const numPlayers = players.length;
  const half = Math.floor(numPlayers / 2);

  const reorderedPlayers = [];
  for (let i = 0; i < numPlayers; i++) {
    const index = (currentPlayerIndex - half + i + numPlayers) % numPlayers;
    reorderedPlayers.push(players[index]);
  }

  return reorderedPlayers;
};

// Dice symbols and emojis
const diceSymbols = ['1', '2', '🏹', '💣', '🍺', '🔫'];

export default function App() {
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

  useEffect(() => {
    const handlers = {
      playerListUpdate: (updatedPlayers) => setPlayers(updatedPlayers),
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
        setPlayers(currentPlayers => {
          const updatedPlayers = [...currentPlayers];
          healthData.forEach(data => {
            const playerIndex = updatedPlayers.findIndex(p => p.socketId === data.socketId);
            if (playerIndex !== -1) {
              updatedPlayers[playerIndex] = {
                ...updatedPlayers[playerIndex],
                health: data.health,
                maxHealth: data.maxHealth
              };
            }
          });
          return updatedPlayers;
        });
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
      Object.keys(handlers).forEach(event => {
        socket.off(event);
      });
    };
  }, []);  // Remove logCounter dependency

  // Add useEffect to handle auto-resolution of dynamites
  useEffect(() => {
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

    // Create an object that includes both dice values and states
    const keptDiceData = {
      dice: {},      // Store actual dice values
      states: {}     // Store states for reference
    };

    // Store both dice values and their states
    diceResult.forEach((dice, index) => {
      if (diceStates[index] === DICE_STATES.KEPT || diceStates[index] === DICE_STATES.RESOLVED) {
        keptDiceData.dice[index] = dice;
        keptDiceData.states[index] = diceStates[index];
      }
    });

    console.log('Sending kept dice:', keptDiceData); // Debug log
    socket.emit('rollDice', keptDiceData);
  };

  const DYNAMITE_SYMBOL = '💣';

  const toggleDiceState = (index, reverse = false) => {
    if (socket.id !== currentTurn) return;
  
    const currentState = diceStates[index] || DICE_STATES.ROLLED;
    
    // Handle reverse action
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

  // Add helper to check for 3+ dynamites
  const hasThreeOrMoreDynamites = () => {
    return Object.entries(diceStates).filter(([index, state]) => 
      diceResult[index] === DYNAMITE_SYMBOL && state === 'resolved'
    ).length >= 3;
  };

  const renderPlayerTile = (player, index) => (
    <div
      key={index}
      className={`player-tile ${player.socketId === currentTurn ? 'active' : ''} ${player.socketId === socket.id ? 'current-player' : ''}`}
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

  return (
    <div className={`app-container ${gameStarted ? 'game-started' : ''}`}>
      {!gameStarted ? (
        <div className="lobby-container">
          <h1 className="title">🎲 Bang! The Dice Game 🎯</h1>
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
              {reorderPlayers(players, socket.id).map((player, index) => 
                renderPlayerTile(player, index)
              )}
            </div>

            {/* Dice Rolling Section */}
            <div className="dice-section">
              <h3>{socket.id === currentTurn ? 'Your Dice' : `${players.find(p => p.socketId === currentTurn)?.name}'s Dice`}</h3>
              <div className="dice-column">
                {diceResult.map((dice, index) => (
                  <div key={index} className="dice-container">
                    <div
                      className={`dice ${diceStates[index]}`}
                      onClick={() => socket.id === currentTurn && toggleDiceState(index)}
                      style={{ cursor: socket.id === currentTurn ? 'pointer' : 'default' }}
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
                ))}
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

            <div className="board-status">
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