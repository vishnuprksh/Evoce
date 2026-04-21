import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, User } from 'firebase/auth';
import { 
  initializeFirestore, 
  doc, 
  setDoc, 
  getDoc, 
  collection, 
  query, 
  where, 
  getDocs, 
  addDoc, 
  updateDoc,
  getDocFromServer
} from 'firebase/firestore';
import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Use Long Polling for better stability in proxy environments
export const db = initializeFirestore(app, {
  experimentalForceLongPolling: true,
}, firebaseConfig.firestoreDatabaseId);

export const storage = getStorage(app);
export const googleProvider = new GoogleAuthProvider();

interface FirestoreErrorInfo {
  error: string;
  operationType: 'create' | 'update' | 'delete' | 'list' | 'get' | 'write';
  path: string | null;
  authInfo: {
    userId: string;
    email: string;
    emailVerified: boolean;
    isAnonymous: boolean;
    providerInfo: { providerId: string; displayName: string; email: string; }[];
  }
}

export const handleFirestoreError = (error: any, operationType: FirestoreErrorInfo['operationType'], path: string | null = null) => {
  if (error?.code === 'permission-denied' || error?.message?.includes('insufficient permissions')) {
    const info: FirestoreErrorInfo = {
      error: error.message,
      operationType,
      path,
      authInfo: {
        userId: auth.currentUser?.uid || 'anonymous',
        email: auth.currentUser?.email || '',
        emailVerified: auth.currentUser?.emailVerified || false,
        isAnonymous: auth.currentUser?.isAnonymous || false,
        providerInfo: auth.currentUser?.providerData.map(p => ({
          providerId: p.providerId,
          displayName: p.displayName || '',
          email: p.email || ''
        })) || []
      }
    };
    throw new Error(JSON.stringify(info));
  }
  throw error;
};

// Connection Verification
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    console.log("Firestore connection verified.");
  } catch (error: any) {
    if (error?.code === 'permission-denied' || error?.message?.includes('insufficient permissions')) {
      // If we got a permission error, it means we SUCCESSFULLY reached the server
      console.log("Firestore connection verified (handshake successful).");
    } else if (error instanceof Error && error.message.includes('the client is offline')) {
      console.warn("Firestore is operating in offline mode. Please check your network or Firebase configuration.");
    } else {
      console.error("Firestore connectivity test failed:", error);
    }
  }
}
testConnection();

export const signInWithGoogle = async () => {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    const user = result.user;
    
    // Create/update user profile
    try {
      await setDoc(doc(db, 'users', user.uid), {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL,
        updatedAt: new Date().toISOString()
      }, { merge: true });
    } catch (e) {
      handleFirestoreError(e, 'write', `users/${user.uid}`);
    }
    
    return user;
  } catch (error) {
    console.error("Error signing in with Google", error);
    throw error;
  }
};

export const uploadBookToStorage = async (uid: string, file: ArrayBuffer, fileName: string) => {
  const storageRef = ref(storage, `users/${uid}/books/${fileName}`);
  await uploadBytes(storageRef, file);
  return await getDownloadURL(storageRef);
};

export const saveBookToFirebase = async (uid: string, metadata: any, storageUrl: string) => {
  try {
    const booksRef = collection(db, 'users', uid, 'books');
    const docRef = await addDoc(booksRef, {
      userId: uid,
      title: metadata.title || 'Untitled',
      creator: metadata.creator || 'Unknown',
      storageUrl,
      createdAt: new Date().toISOString(),
      lastHref: ''
    });
    return docRef.id;
  } catch (e) {
    handleFirestoreError(e, 'create', `users/${uid}/books`);
    throw e;
  }
};

export const getBooksFromFirebase = async (uid: string) => {
  try {
    const booksRef = collection(db, 'users', uid, 'books');
    const snapshot = await getDocs(booksRef);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (e) {
    handleFirestoreError(e, 'list', `users/${uid}/books`);
    throw e;
  }
};

export const uploadAudioToStorage = async (uid: string, bookId: string, chapterHref: string, audioBlob: Blob) => {
  const sanitizedHref = chapterHref.replace(/[/\\?%*:|"<>]/g, '-');
  const storageRef = ref(storage, `users/${uid}/books/${bookId}/chapters/${sanitizedHref}.wav`);
  await uploadBytes(storageRef, audioBlob);
  return await getDownloadURL(storageRef);
};

export const saveChapterTTS = async (uid: string, bookId: string, chapterHref: string, audioUrl: string, text: string) => {
  try {
    const chaptersRef = collection(db, 'users', uid, 'books', bookId, 'chapters');
    const q = query(chaptersRef, where('chapterHref', '==', chapterHref));
    const snapshot = await getDocs(q);
    
    const data = {
      userId: uid,
      bookId,
      chapterHref,
      audioUrl,
      text,
      updatedAt: new Date().toISOString()
    };

    if (!snapshot.empty) {
      await updateDoc(doc(db, 'users', uid, 'books', bookId, 'chapters', snapshot.docs[0].id), data);
    } else {
      await addDoc(chaptersRef, data);
    }
  } catch (e) {
    handleFirestoreError(e, 'write', `users/${uid}/books/${bookId}/chapters`);
    throw e;
  }
};

export const getChaptersFromFirebase = async (uid: string, bookId: string) => {
  try {
    const chaptersRef = collection(db, 'users', uid, 'books', bookId, 'chapters');
    const snapshot = await getDocs(chaptersRef);
    return snapshot.docs.map(doc => doc.data());
  } catch (e) {
    handleFirestoreError(e, 'list', `users/${uid}/books/${bookId}/chapters`);
    throw e;
  }
};
