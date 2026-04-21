import React, { useState, useEffect, useRef, useCallback, ChangeEvent } from 'react';
import ePub from 'epubjs';
import type { Book, Rendition } from 'epubjs';
import { 
  Play, 
  Pause, 
  SkipForward, 
  SkipBack, 
  Upload, 
  Book as BookIcon, 
  X,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Menu,
  CloudDownload,
  CheckCircle2,
  LogOut,
  User as UserIcon,
  Trash2
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from './lib/utils';
import { GoogleGenAI, Modality } from '@google/genai';
import { auth, signInWithGoogle, saveBookToFirebase, getBooksFromFirebase, saveChapterTTS, getChaptersFromFirebase, db, uploadBookToStorage, uploadAudioToStorage } from './lib/firebase';
import { onAuthStateChanged, signOut, User } from 'firebase/auth';
import { doc, updateDoc, deleteDoc } from 'firebase/firestore';

interface Chapter {
  label: string;
  href: string;
  idref?: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  audioUrl?: string;
  text?: string;
}

interface SavedBook {
  id: string;
  title: string;
  creator: string;
  storageUrl: string;
  lastHref: string;
}

interface LoadingState {
  status: boolean;
  message: string;
}

// Helper to convert RAW PCM to WAV
function pcmToWav(base64PcmOrArray: string | string[], sampleRate = 24000) {
  let binary = '';
  if (Array.isArray(base64PcmOrArray)) {
    binary = base64PcmOrArray.map(b64 => atob(b64)).join('');
  } else {
    binary = atob(base64PcmOrArray);
  }
  
  const length = binary.length;
  const buffer = new ArrayBuffer(44 + length);
  const view = new DataView(buffer);

  // RIFF identifier
  view.setUint32(0, 0x52494646, false);
  // file length
  view.setUint32(4, 36 + length, true);
  // RIFF type
  view.setUint32(8, 0x57415645, false);
  // format chunk identifier
  view.setUint32(12, 0x666d7420, false);
  // format chunk length
  view.setUint16(16, 16, true); // wait, should be Uint32 for length
  view.setUint32(16, 16, true);
  // sample format (raw pcm = 1)
  view.setUint16(20, 1, true);
  // channel count (mono = 1)
  view.setUint16(22, 1, true);
  // sample rate
  view.setUint32(24, sampleRate, true);
  // byte rate
  view.setUint32(28, sampleRate * 2, true);
  // block align
  view.setUint16(32, 2, true);
  // bits per sample
  view.setUint16(34, 16, true);
  // data chunk identifier
  view.setUint32(36, 0x64617461, false);
  // data chunk length
  view.setUint32(40, length, true);

  for (let i = 0; i < length; i++) {
    view.setUint8(44 + i, binary.charCodeAt(i));
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [userBooks, setUserBooks] = useState<SavedBook[]>([]);
  const [currentBookId, setCurrentBookId] = useState<string | null>(null);
  const [book, setBook] = useState<Book | null>(null);
  const [rendition, setRendition] = useState<Rendition | null>(null);
  const [loading, setLoading] = useState<LoadingState>({ status: false, message: '' });
  const [initialLoading, setInitialLoading] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [showToc, setShowToc] = useState(false);
  const [metadata, setMetadata] = useState<{ title?: string; creator?: string }>({});
  const [playbackRate, setPlaybackRate] = useState(() => {
    const saved = localStorage.getItem('evoce_playback_rate');
    return saved ? parseFloat(saved) : 1;
  });
  const [currentChapterIndex, setCurrentChapterIndex] = useState(0);
  
  const viewerRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const statsRef = useRef<HTMLDivElement>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const wasPlayingRef = useRef(false);

  const aiRef = useRef(new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }));

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        await refreshUserBooks(u.uid);
      } else {
        setUserBooks([]);
        setBook(null);
        setRendition(null);
        setCurrentBookId(null);
      }
      setInitialLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const refreshUserBooks = async (uid: string) => {
    const books = await getBooksFromFirebase(uid);
    setUserBooks(books as SavedBook[]);
  };

  const loadSavedBook = async (savedBook: SavedBook) => {
    setLoading({ status: true, message: 'Opening your library...' });
    setBook(null);
    setRendition(null);
    setChapters([]);
    setCurrentBookId(savedBook.id);
    
    try {
      setLoading({ status: true, message: 'Loading digital content...' });
      const newBook = ePub(savedBook.storageUrl);
      await newBook.ready;
      
      setLoading({ status: true, message: 'Mapping chapters...' });
      const spine = await newBook.loaded.spine;
      const navigation = await newBook.loaded.navigation;
      
      const chapterItems: Chapter[] = [];
      
      (spine as any).each((item: any) => {
        // Try to match spine item with a TOC entry for a readable label
        const tocMatch = navigation.toc.find(t => t.href.split('#')[0] === item.href);
        chapterItems.push({
          label: tocMatch ? tocMatch.label : `Section`,
          href: item.href,
          idref: item.idref,
          status: 'idle'
        });
      });

      // Load cached chapters
      const cachedChapters = await getChaptersFromFirebase(user!.uid, savedBook.id);
      cachedChapters.forEach((cached: any) => {
        const index = chapterItems.findIndex(c => c.href === cached.chapterHref);
        if (index !== -1) {
          chapterItems[index].status = 'ready';
          chapterItems[index].text = cached.text;
          chapterItems[index].audioUrl = cached.audioUrl;
        }
      });
      
      setMetadata({ title: savedBook.title, creator: savedBook.creator });
      setChapters(chapterItems);
      setBook(newBook);
      setLoading({ status: false, message: '' });

      // Display from last known position
      if (savedBook.lastHref) {
        setTimeout(() => rendition?.display(savedBook.lastHref), 100);
      }
    } catch (error) {
      console.error('Error loading saved book:', error);
      setLoading({ status: false, message: '' });
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;

    setLoading({ status: true, message: 'Uploading to library...' });
    try {
      const arrayBuffer = await file.arrayBuffer();
      const storageUrl = await uploadBookToStorage(user.uid, arrayBuffer, file.name);

      setLoading({ status: true, message: 'Registering metadata...' });
      const newBook = ePub(arrayBuffer);
      await newBook.ready;
      
      const meta = await newBook.loaded.metadata;
      const bookId = await saveBookToFirebase(user.uid, meta, storageUrl);
      
      await refreshUserBooks(user.uid);
      
      const saved: SavedBook = {
        id: bookId,
        title: meta.title || 'Untitled',
        creator: meta.creator || 'Unknown',
        storageUrl,
        lastHref: ''
      };

      loadSavedBook(saved);
    } catch (error) {
       console.error('Upload failed', error);
       setLoading({ status: false, message: '' });
    }
  };

  const deleteBook = async (e: React.MouseEvent, bookId: string) => {
    e.stopPropagation();
    if (!user) return;
    
    // We remove the sandboxed confirm() since preview blocks browser modals.
    // In a full production build, a custom UI modal should be used instead.
    try {
      await deleteDoc(doc(db, 'users', user.uid, 'books', bookId));
      if (currentBookId === bookId) setBook(null);
      await refreshUserBooks(user.uid);
    } catch (err) {
      console.error('Delete failed', err);
    }
  };

  const getChapterText = async (href: string) => {
    if (!book) return '';
    const section = book.spine.get(href);
    if (!section) return '';
    await section.load(book.load.bind(book));
    const document = section.document;
    const text = document.body.innerText || document.body.textContent || '';
    return text.trim().replace(/\s+/g, ' ');
  };

  const downloadChapterTTS = async (index: number) => {
    if (!user || !currentBookId) return;
    const chapter = chapters[index];
    if (!chapter || chapter.status !== 'idle') return;

    setChapters(prev => prev.map((c, i) => i === index ? { ...c, status: 'loading' } : c));

    try {
      const text = chapter.text || await getChapterText(chapter.href);
      const textToSpeak = text.trim(); 

      if (!textToSpeak) {
        // Skip structural sections that contain no text
        setChapters(prev => prev.map((c, i) => i === index ? { 
          ...c, 
          status: 'ready', 
          audioUrl: '',
          text: '' 
        } : c));
        return;
      }

      const CHUNK_SIZE = 15000; // ≈4000 tokens, safely below 8192 token limit
      let currentIndex = 0;
      let allBase64Audio: string[] = [];

      while (currentIndex < textToSpeak.length) {
        let nextIndex = currentIndex + CHUNK_SIZE;
        // avoid cutting words in half
        if (nextIndex < textToSpeak.length) {
           const lastSpace = textToSpeak.lastIndexOf(' ', nextIndex);
           if (lastSpace > currentIndex) {
              nextIndex = lastSpace;
           }
        }
        
        const chunk = textToSpeak.slice(currentIndex, nextIndex);

        const response = await aiRef.current.models.generateContent({
          model: "gemini-3.1-flash-tts-preview",
          contents: [{ parts: [{ text: `Read this story segment elegantly: ${chunk}` }] }],
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: 'Kore' },
              },
            },
          },
        });

        const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (base64Audio) allBase64Audio.push(base64Audio);

        currentIndex = nextIndex;
      }

      if (allBase64Audio.length > 0) {
        const audioBlob = pcmToWav(allBase64Audio);
        const audioUrl = await uploadAudioToStorage(user.uid, currentBookId, chapter.href, audioBlob);
        await saveChapterTTS(user.uid, currentBookId, chapter.href, audioUrl, text);
        setChapters(prev => prev.map((c, i) => i === index ? { 
          ...c, 
          status: 'ready', 
          audioUrl,
          text 
        } : c));
      } else {
        throw new Error('No audio generated');
      }
    } catch (error) {
      console.error('TTS Download failed', error);
      setChapters(prev => prev.map((c, i) => i === index ? { ...c, status: 'error' } : c));
    }
  };

  // Auto-Process Queue: Continually feed ungenerated sections to the TTS engine
  useEffect(() => {
    if (!user || !currentBookId || chapters.length === 0) return;
    
    // Check if any chapter is currently generating to prevent hammering the API
    const isGenerating = chapters.some(c => c.status === 'loading');
    if (isGenerating) return;

    // Output next idle chapter to the API
    const nextIdleIndex = chapters.findIndex(c => c.status === 'idle');
    if (nextIdleIndex !== -1) {
      downloadChapterTTS(nextIdleIndex);
    }
  }, [chapters, user, currentBookId]);

  // Handle Rendition in useEffect to ensure viewerRef.current is ready
  useEffect(() => {
    let active = true;

    if (book && viewerRef.current && !rendition) {
      const initRendition = async () => {
        try {
          const newRendition = book.renderTo(viewerRef.current!, {
            width: '100%',
            height: '100%',
            flow: 'paginated',
            manager: 'default',
            allowScriptedContent: true
          });
          
          const applyTheme = () => {
            newRendition.themes.default({
              'body': {
                'font-family': '"Crimson Pro", "Georgia", serif !important',
                'color': '#E5E5E5 !important',
                'background': 'transparent !important',
                'font-size': '20px !important',
                'line-height': '1.7 !important',
                'text-align': 'center !important'
              },
              'p': {
                'margin-bottom': '1.5em !important',
                'font-style': 'italic !important',
                'padding': '0 20px !important'
              }
            });
          };

          await newRendition.display();
          
          if (active) {
            applyTheme();
            setRendition(newRendition);

            newRendition.on('relocation', async (location: any) => {
              const href = location.start.href;
              const index = chapters.findIndex(c => c.href === href);
              if (index !== -1) setCurrentChapterIndex(index);
              
              // Save progress
              if (user && currentBookId) {
                await updateDoc(doc(db, 'users', user.uid, 'books', currentBookId), {
                  lastHref: href
                });
              }
            });
          }
        } catch (err) {
          console.error('Error rendering book:', err);
        }
      };

      initRendition();
    }

    return () => {
      active = false;
    };
  }, [book, rendition, chapters]);

  const stopSpeaking = () => {
    if (audioRef.current) {
      audioRef.current.pause();
    }
    setIsPlaying(false);
  };

  const startSpeaking = async (specificIndex?: number) => {
    const targetIndex = specificIndex !== undefined ? specificIndex : currentChapterIndex;
    const chapter = chapters[targetIndex];
    if (!chapter) return;
    
    if (chapter.status === 'ready' && chapter.audioUrl) {
      if (isPlaying && specificIndex === undefined) {
        stopSpeaking();
      } else {
        if (!audioRef.current) {
          audioRef.current = new Audio(chapter.audioUrl);
          audioRef.current.onended = () => {
            setIsPlaying(false);
            // Auto next chapter?
            if (targetIndex < chapters.length - 1) {
               wasPlayingRef.current = true;
               const nextChapter = chapters[targetIndex + 1];
               rendition?.display(nextChapter.idref || nextChapter.href);
            }
          };
        } else if (audioRef.current.src !== chapter.audioUrl) {
          audioRef.current.src = chapter.audioUrl;
          // IMPORTANT: we must update the closure for onended to reference the new index
          audioRef.current.onended = () => {
             setIsPlaying(false);
             if (targetIndex < chapters.length - 1) {
                wasPlayingRef.current = true;
                const nextChapter = chapters[targetIndex + 1];
                rendition?.display(nextChapter.idref || nextChapter.href);
             }
          };
        }
        audioRef.current.playbackRate = playbackRate;
        audioRef.current.play();
        setIsPlaying(true);
      }
    } else {
      // Trigger download
      downloadChapterTTS(targetIndex);
    }
  };

  // Wait for new chapters to be ready and auto-play if queued
  useEffect(() => {
     if (wasPlayingRef.current && chapters[currentChapterIndex]) {
        const chapter = chapters[currentChapterIndex];
        if (chapter.status === 'ready' && chapter.audioUrl) {
           wasPlayingRef.current = false;
           startSpeaking(currentChapterIndex);
        } else if (chapter.status === 'idle') {
           downloadChapterTTS(currentChapterIndex);
        }
     }
  }, [currentChapterIndex, chapters]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
    localStorage.setItem('evoce_playback_rate', playbackRate.toString());
  }, [playbackRate]);

  // Synchronize audio playback with EPUB pages (track percentage and turn pages)
  useEffect(() => {
    let updateInterval: NodeJS.Timeout;
    let isPaging = false;
    
    if (isPlaying && rendition && audioRef.current) {
      updateInterval = setInterval(() => {
        if (isPaging) return;
        const audio = audioRef.current;
        if (!audio || !audio.duration) return;
        
        const progress = audio.currentTime / audio.duration;
        const audioPercent = (progress * 100).toFixed(1);
        
        if (progressBarRef.current) {
          progressBarRef.current.style.width = `${progress * 100}%`;
        }

        try {
          const contents = rendition.getContents();
          if (contents && contents.length > 0) {
            const doc = contents[0].document;
            
            // Extract all text nodes from the body to ensure we don't miss content inside divs/spans
            const textNodes: Node[] = [];
            const walk = doc.createTreeWalker(doc.body, 4, null); // 4 = NodeFilter.SHOW_TEXT
            let n;
            while((n = walk.nextNode())) {
              if (n.textContent && n.textContent.trim().length > 0) {
                textNodes.push(n);
              }
            }
            
            let totalChars = 0;
            const elementsWithStats = textNodes.map(node => {
              const htmlEl = node.parentElement as HTMLElement;
              const length = node.textContent?.length || 0;
              const stats = { node, el: htmlEl, startChar: totalChars, length };
              totalChars += length;
              return stats;
            });
            
            if (totalChars === 0) {
              if (statsRef.current) {
                statsRef.current.innerText = `AUDIO: ${audioPercent}% | TEXT: --% | BOUNDS: --`;
              }
              return;
            }
            
            const currentChar = totalChars * progress;
            
            let activeElement: HTMLElement | null = null;
            let currentPercentage = 0;
            
            // Use safer viewport width values
            const clientWidth = doc.documentElement.clientWidth;
            const winWidth = Math.min(contents[0].window.innerWidth, clientWidth);
            
            let visibleStart = 0;
            let visibleEnd = totalChars;
            let targetRect: DOMRect | null = null;
            
            // Native epub.js pagination bounds
            try {
              const loc = rendition.currentLocation() as any;
              if (loc && loc.start && loc.end) {
                  const startR = rendition.getRange(loc.start.cfi);
                  const endR = rendition.getRange(loc.end.cfi);
                   
                  let foundStart = false;
                  let foundEnd = false;
                   
                  for (const stat of elementsWithStats) {
                      // Check Start
                      if (!foundStart) {
                          if (startR.startContainer === stat.node) {
                              visibleStart = stat.startChar + startR.startOffset;
                              foundStart = true;
                          } else if (startR.startContainer.contains && startR.startContainer.contains(stat.node)) {
                              visibleStart = stat.startChar; 
                              foundStart = true;
                          }
                      }
                      
                      // Check End
                      if (!foundEnd) {
                          if (endR.endContainer === stat.node) {
                              visibleEnd = stat.startChar + endR.endOffset;
                              foundEnd = true;
                          } else if (endR.endContainer.contains && endR.endContainer.contains(stat.node)) {
                              visibleEnd = stat.startChar + stat.length;
                          } else if (foundStart && visibleEnd < stat.startChar) {
                              // If we passed the end element
                              foundEnd = true;
                          }
                      }
                  }
              }
            } catch(e) {}

            for (let i = 0; i < elementsWithStats.length; i++) {
              const stat = elementsWithStats[i];
              if (stat.length === 0) continue;
              
              // Find active speaking element node
              if (!activeElement && currentChar >= Math.max(0, stat.startChar - 1) && currentChar <= stat.startChar + stat.length) {
                activeElement = stat.el;
                currentPercentage = (currentChar - stat.startChar) / Math.max(1, stat.length);
                
                try {
                  const targetOffset = Math.floor(currentPercentage * stat.length);
                  const range = doc.createRange();
                  range.setStart(stat.node, targetOffset);
                  range.setEnd(stat.node, Math.min(targetOffset + 1, stat.length));
                  targetRect = range.getBoundingClientRect();
                } catch(e) {}
              }
            }

            const visibleStartPct = ((visibleStart / totalChars) * 100).toFixed(1);
            const visibleEndPct = ((visibleEnd / totalChars) * 100).toFixed(1);
            const trackingPct = ((currentChar / totalChars) * 100).toFixed(1);

            if (statsRef.current) {
              const debugX = targetRect ? `${Math.round(targetRect.left)}/${Math.round(winWidth)}px` : '--';
              statsRef.current.innerText = `AUDIO: ${audioPercent}% | TEXT: ${trackingPct}% | BOUNDS: ${visibleStartPct}%-${visibleEndPct}% | TX: ${debugX}`;
            }

            if (activeElement) {
               const rectToCheck = targetRect || activeElement.getBoundingClientRect();
               
               // 1. Math coordinate tracking
               const isCoordNext = rectToCheck.left >= winWidth - 15;
               const isCoordPrev = rectToCheck.right <= 15 && rectToCheck.left < 0;

               // 2. Percentage progress tracking (user request)
               const trackingPctNum = parseFloat(trackingPct);
               const visibleEndPctNum = parseFloat(visibleEndPct);
               const visibleStartPctNum = parseFloat(visibleStartPct);

               const isPctNext = (trackingPctNum > visibleEndPctNum + 0.5) && visibleEndPctNum > 0;
               const isPctPrev = (trackingPctNum < visibleStartPctNum - 0.5) && visibleStartPctNum > 0;

               if (isCoordNext || isPctNext) {
                   if (!isPaging) {
                       isPaging = true;
                       rendition.next();
                       setTimeout(() => isPaging = false, 500); // Debounce flip
                   }
               } else if (isCoordPrev || isPctPrev) {
                   if (!isPaging) {
                       isPaging = true;
                       rendition.prev();
                       setTimeout(() => isPaging = false, 500); // Debounce flip
                   }
               }
            }
          }
        } catch (e) {
          console.warn('Could not track text progress:', e);
        }
      }, 250);
    }
    
    return () => {
      if (updateInterval) clearInterval(updateInterval);
    };
  }, [isPlaying, rendition]);

  const goToChapter = (index: number) => {
    const chapter = chapters[index];
    if (rendition) {
      wasPlayingRef.current = isPlaying;
      stopSpeaking();
      
      const target = chapter.idref || chapter.href;
      console.log('Jumping to chapter target:', target);
      rendition.display(target).catch(err => console.error('Epub.js display failed:', err));
      
      setCurrentChapterIndex(index);
      setShowToc(false);
    }
  };

  const handleGoHome = () => {
    stopSpeaking();
    setBook(null);
    setRendition(null);
    setChapters([]);
    setCurrentBookId(null);
    setShowToc(false);
  };

  return (
    <div className="relative h-screen w-full flex flex-col font-sans selection:bg-gold-accent/30 bg-dark-bg text-text-bright">
      <div className="atmosphere" />
      
      {/* Header */}
      <header className="border-b border-dark-border flex items-center justify-between px-6 h-[60px] z-20 bg-dark-bg">
        <button onClick={handleGoHome} className="flex items-center gap-3 hover:opacity-80 transition-opacity cursor-pointer">
          <div className="w-8 h-8 rounded-sm bg-gold-accent flex items-center justify-center">
            <BookIcon className="w-5 h-5 text-dark-bg" />
          </div>
          <div className="text-left max-w-[200px] md:max-w-xs truncate">
            <h1 className="text-sm font-bold tracking-[0.2em] uppercase text-gold-accent truncate">
              {book && chapters[currentChapterIndex] ? chapters[currentChapterIndex].label : "Evoce"}
            </h1>
          </div>
        </button>

        {user && (
          <div className="flex items-center gap-4">
             <button 
              onClick={() => signOut(auth)}
              className="p-2 hover:bg-white/5 rounded-sm text-text-dim hover:text-gold-accent transition-colors"
              title="Sign Out"
            >
              <LogOut className="w-5 h-5" />
            </button>
            {book && (
              <button 
                onClick={() => setShowToc(!showToc)}
                className="p-2 hover:bg-gold-accent/10 rounded-sm text-gold-accent transition-colors"
                aria-label="Table of Contents"
              >
                <Menu className="w-5 h-5" />
              </button>
            )}
          </div>
        )}
      </header>

      {/* Main Content */}
      <main className="flex-1 relative overflow-hidden flex flex-col items-center">
        {!user && !initialLoading && (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-dark-bg/50">
            <motion.div 
               initial={{ opacity: 0, y: 20 }}
               animate={{ opacity: 1, y: 0 }}
               className="elegant-card p-12 max-w-sm rounded-sm flex flex-col items-center gap-10"
            >
               <div className="w-20 h-20 rounded-full bg-gold-accent flex items-center justify-center shadow-2xl shadow-gold-accent/20">
                 <UserIcon className="w-10 h-10 text-dark-bg" />
               </div>
               <div className="space-y-3">
                 <h2 className="text-2xl font-serif text-text-bright">Personal Library</h2>
                 <p className="text-text-dim text-xs leading-relaxed">Sign in to save your books and narration progress across your devices.</p>
               </div>
               <button 
                 onClick={signInWithGoogle}
                 className="w-full bg-gold-accent text-dark-bg py-4 rounded-sm font-bold uppercase tracking-widest text-[10px] hover:bg-gold-accent/90 transition-all active:scale-95"
               >
                 Sign in with Google
               </button>
            </motion.div>
          </div>
        )}

        {user && !book && !loading.status && (
          <div className="flex-1 w-full max-w-4xl p-4 md:p-8 flex flex-col gap-8 md:gap-12 overflow-y-auto custom-scrollbar">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6 md:gap-0 border-b border-dark-border pb-6">
              <div className="w-full md:w-auto">
                <h2 className="text-2xl font-serif text-text-bright line-clamp-1">Welcome back, {user.displayName?.split(' ')[0]}</h2>
                <p className="text-text-dim text-xs tracking-widest uppercase mt-1">Select from your collection</p>
              </div>
              <label className="cursor-pointer group block w-full md:w-auto shrink-0">
                <input type="file" accept=".epub" onChange={handleFileUpload} className="hidden" />
                <div className="bg-white/5 border border-dark-border text-text-bright py-3 md:py-2.5 px-6 rounded-sm text-[10px] uppercase font-bold tracking-widest hover:border-gold-accent transition-all flex items-center justify-center gap-2">
                  <Upload className="w-4 h-4" />
                  Upload EPUB
                </div>
              </label>
            </div>

             {userBooks.length === 0 ? (
               <div className="flex-1 flex flex-col items-center justify-center py-20 opacity-40">
                 <BookIcon className="w-16 h-16 mb-6" />
                 <p className="text-xs uppercase tracking-widest font-bold">Your shelf is empty</p>
               </div>
             ) : (
               <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 md:gap-6 pb-20">
                 {userBooks.map((b) => (
                   <motion.div 
                     layoutId={b.id}
                     key={b.id}
                     onClick={() => loadSavedBook(b)}
                     className="group cursor-pointer space-y-4"
                   >
                     <div className="aspect-[3/4] bg-dark-card border border-dark-border rounded-sm relative shadow-xl group-hover:border-gold-accent transition-all overflow-hidden flex flex-col items-center justify-center p-6 text-center">
                        <div className="absolute left-3 top-0 bottom-0 w-px bg-white/5" />
                        <BookIcon className="w-10 h-10 text-text-dim group-hover:text-gold-accent mb-4 transition-colors" />
                        <h3 className="text-xs font-bold line-clamp-2 text-text-bright">{b.title}</h3>
                        <p className="text-[10px] text-text-dim mt-2 truncate w-full">{b.creator}</p>
                        
                        <button 
                          onClick={(e) => deleteBook(e, b.id)}
                          className="absolute top-2 right-2 p-2 text-text-dim hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                     </div>
                   </motion.div>
                 ))}
               </div>
             )}
          </div>
        )}

        {(initialLoading || loading.status) && (
          <div className="flex-1 flex flex-col items-center justify-center gap-6">
            <div className="relative">
              <Loader2 className="w-12 h-12 text-gold-accent animate-spin" />
            </div>
            <p className="font-sans text-[10px] uppercase tracking-[0.2em] text-text-dim font-bold animate-pulse">
              {initialLoading ? 'Connecting to Archive...' : loading.message}
            </p>
          </div>
        )}

        {book && !loading.status && (
          <div 
            key={metadata.title || 'reader'}
            className="flex-1 w-full max-w-2xl mx-auto px-4 py-2 md:py-16 overflow-hidden relative flex flex-col"
          >
            <div ref={statsRef} className="absolute top-2 left-4 right-4 text-[9px] font-mono text-gold-accent/50 pointer-events-none z-50 text-right md:text-center tracking-widest leading-relaxed">
               AUDIO: --% | TEXT-SYNC: --% | VISIBLE PAGE BOUNDS: --
            </div>
            <div 
              ref={viewerRef} 
              className="flex-1 w-full p-2 overflow-hidden bg-transparent"
            />
            
            {/* Desktop Navigation Hints */}
            <div className="hidden md:flex absolute inset-x-0 top-1/2 -translate-y-1/2 justify-between px-0 pointer-events-none">
              <button 
                onClick={() => { rendition?.prev(); }}
                className="pointer-events-auto p-4 text-text-dim hover:text-gold-accent transition-all active:scale-90"
              >
                <ChevronLeft className="w-10 h-10" />
              </button>
              <button 
                onClick={() => { rendition?.next(); }}
                className="pointer-events-auto p-4 text-text-dim hover:text-gold-accent transition-all active:scale-90"
              >
                <ChevronRight className="w-10 h-10" />
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Reader Controls */}
      <AnimatePresence>
        {book && (
          <motion.footer 
            initial={{ y: 100 }}
            animate={{ y: 0 }}
            exit={{ y: 100 }}
            className="bg-dark-bg border-t border-dark-border px-4 md:px-8 h-[90px] md:h-[100px] z-30 flex items-center"
          >
            <div className="w-full flex items-center justify-between gap-4 md:gap-12 max-w-6xl mx-auto">
              {/* Progress - Left */}
              <div className="hidden lg:flex flex-col w-[300px] gap-2 shrink-0">
                <div className="h-1 bg-dark-border rounded-full w-full overflow-hidden">
                   <div
                     ref={progressBarRef} 
                     className="h-full bg-gold-accent transition-all duration-300 ease-linear" 
                     style={{ width: '0%' }}
                   />
                </div>
                <div className="flex justify-between text-[10px] text-text-dim tracking-widest font-bold">
                   <span>PREV</span>
                   <span>NEXT</span>
                </div>
              </div>

              {/* Main Playback - Center */}
              <div className="flex items-center justify-start md:justify-center gap-4 md:gap-8 flex-1">
                <button 
                  onClick={() => { 
                    if (currentChapterIndex > 0) goToChapter(currentChapterIndex - 1); 
                  }}
                  className="p-2 -ml-2 md:m-0 text-text-bright hover:text-gold-accent transition-colors active:scale-90"
                  disabled={currentChapterIndex === 0}
                >
                  <SkipBack className="w-5 h-5" />
                </button>
                
                <div className="relative group shrink-0">
                  <button 
                    onClick={() => startSpeaking()}
                    disabled={chapters[currentChapterIndex]?.status === 'loading'}
                    className={cn(
                      "w-12 h-12 md:w-14 md:h-14 rounded-full flex items-center justify-center shadow-lg transition-all active:scale-95",
                      chapters[currentChapterIndex]?.status === 'ready' 
                        ? "bg-gold-accent shadow-gold-accent/20" 
                        : "bg-dark-border text-text-dim hover:text-gold-accent"
                    )}
                  >
                    {chapters[currentChapterIndex]?.status === 'loading' ? (
                      <Loader2 className="w-6 h-6 animate-spin" />
                    ) : isPlaying ? (
                      <Pause className="w-5 h-5 md:w-6 md:h-6 text-dark-bg fill-current" />
                    ) : chapters[currentChapterIndex]?.status === 'ready' ? (
                      <Play className="w-5 h-5 md:w-6 md:h-6 text-dark-bg fill-current ml-0.5" />
                    ) : (
                      <CloudDownload className="w-5 h-5 md:w-6 md:h-6" />
                    )}
                  </button>
                  {chapters[currentChapterIndex]?.status === 'idle' && (
                    <motion.div 
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="absolute bottom-14 md:-top-12 left-1/2 -translate-x-1/2 bg-gold-accent text-dark-bg text-[9px] font-bold px-3 py-1.5 rounded-sm whitespace-nowrap uppercase tracking-widest pointer-events-none shadow-xl z-50"
                    >
                      Download
                    </motion.div>
                  )}
                </div>
                
                <button 
                  onClick={() => { 
                    if (currentChapterIndex < chapters.length - 1) goToChapter(currentChapterIndex + 1); 
                  }}
                  className="p-2 text-text-bright hover:text-gold-accent transition-colors active:scale-90"
                  disabled={currentChapterIndex >= chapters.length - 1}
                >
                  <SkipForward className="w-5 h-5" />
                </button>
              </div>

              {/* Settings - Right */}
              <div className="flex items-center gap-6 md:gap-8 justify-end shrink-0">
                <div className="hidden md:flex flex-col gap-1 items-end">
                  <span className="text-[9px] uppercase tracking-widest text-text-dim font-bold">Voice Model</span>
                  <div className="text-[12px] font-bold text-gold-accent">AI Kore (Natural)</div>
                </div>

                <div className="flex flex-col gap-1 items-end">
                  <span className="text-[9px] uppercase tracking-widest text-text-dim font-bold hidden md:inline">Speed</span>
                  <span className="text-[9px] uppercase tracking-widest text-text-dim font-bold md:hidden">Spd</span>
                  <button 
                    onClick={() => { setPlaybackRate(prev => prev >= 2.0 ? 0.75 : prev + 0.25); }}
                    className="text-[12px] font-bold text-gold-accent hover:text-text-bright transition-colors"
                  >
                    {playbackRate.toFixed(2)}x
                  </button>
                </div>
              </div>
            </div>
          </motion.footer>
        )}
      </AnimatePresence>

      {/* TOC Sidebar */}
      <AnimatePresence>
        {showToc && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowToc(false)}
              className="fixed inset-0 bg-[#0a0502]/80 backdrop-blur-md z-40"
            />
            <motion.aside 
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed right-0 top-0 h-full w-full max-w-sm bg-dark-card z-50 p-6 md:p-8 flex flex-col border-l border-dark-border"
            >
              <div className="flex items-center justify-between mb-8 md:mb-10">
                <div>
                  <h2 className="text-sm font-bold tracking-[0.2em] uppercase text-gold-accent">Library</h2>
                  <p className="text-[9px] uppercase tracking-widest text-text-dim font-bold mt-1">Reader Shelf</p>
                </div>
                <button onClick={() => setShowToc(false)} className="p-2 hover:bg-white/5 rounded-sm transition-all active:scale-90 text-text-dim">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto space-y-4 pr-2 custom-scrollbar">
                {chapters.map((chapter, i) => (
                  <div key={`${chapter.href}-${i}`} className="flex items-center group">
                    <button
                      onClick={() => goToChapter(i)}
                      className="flex-1 text-left flex gap-4 items-center group active:scale-[0.98]"
                    >
                      <div className="w-10 h-14 bg-dark-bg border border-dark-border rounded-sm flex-shrink-0 shadow-lg group-hover:border-gold-accent transition-colors relative">
                        <div className="absolute left-1.5 top-0 bottom-0 w-px bg-white/5" />
                        {chapter.status === 'ready' && (
                          <div className="absolute inset-0 flex items-center justify-center bg-gold-accent/10">
                            <CheckCircle2 className="w-5 h-5 text-gold-accent" />
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col overflow-hidden">
                        <span className="text-[11px] font-bold text-text-bright group-hover:text-gold-accent transition-colors line-clamp-1">{chapter.label}</span>
                        <span className="text-[9px] text-text-dim uppercase tracking-wider">Chapter {(i + 1).toString().padStart(2, '0')}</span>
                      </div>
                    </button>
                    
                    <button 
                      onClick={() => downloadChapterTTS(i)}
                      disabled={chapter.status !== 'idle'}
                      className={cn(
                        "p-3 rounded-sm transition-all",
                        chapter.status === 'ready' ? "text-gold-accent" : "text-text-dim hover:text-gold-accent hover:bg-white/5"
                      )}
                    >
                      {chapter.status === 'loading' ? (
                        <Loader2 className="w-5 h-5 animate-spin" />
                      ) : chapter.status === 'ready' ? (
                        <CheckCircle2 className="w-5 h-5" />
                      ) : (
                        <CloudDownload className="w-5 h-5" />
                      )}
                    </button>
                  </div>
                ))}
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
