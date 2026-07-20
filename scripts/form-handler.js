// Add these at the very top of your frontend application script file (.js)
// Authoritative Form Submission Handler Engine
export async function handleApplySubmit(event) {
  event.preventDefault();
  
  const form = event.target;
  
  // Use explicit IDs or names from your HTML elements instead of placeholder searching
  const emailInput = document.getElementById('emailInput')?.value.trim() || form.querySelector('input[type="email"]')?.value.trim();
  const nameInput = document.getElementById('nameInput')?.value.trim() || form.querySelector('input[type="text"]')?.value.trim();
  const phoneInput = document.getElementById('phoneInput')?.value.trim() || form.querySelector('input[type="tel"]')?.value.trim();
  const programSelect = document.getElementById('programSelect')?.value;
  
  // Safely grab the textarea value, defaulting to an empty string if it's empty
  const textareaEl = form.querySelector('textarea');
  const notesInput = textareaEl ? textareaEl.value.trim() : "";

  // Fail early if crucial parameters are completely missing in action
  if (!emailInput || !nameInput || !phoneInput || !programSelect) {
    displayStatusScreen('error', 'Missing Data', 'Please fill out all mandatory fields.');
    return;
  }

  const normalizedEmailId = emailInput.toLowerCase();
  showStatusOverlay('Sending your application...', 'Please hold on while we check and submit your details to admissions.');

  try {
    const appDocRef = doc(db, "applications", normalizedEmailId);

    const applicationPayload = {
      fullName: nameInput,
      phone: phoneInput,
      email: normalizedEmailId,
      program: programSelect,
      notes: notesInput, // Must be present as a key, even if it's an empty string ""
      submittedAt: serverTimestamp() 
    };

    await setDoc(appDocRef, applicationPayload);
    displayStatusSuccess();
    form.reset();

  } catch (error) {
  console.error("Error Code:", error.code);
  console.error("Error Message:", error.message);
  console.error("Full Error:", error);
  
  if (error.code === 'permission-denied') {
    displayStatusScreen(
      'error',
      'Application Error',
      error.message
    );
  } else {
    displayStatusScreen(
      'error',
      'Submission Failed',
      error.message
      );
    }
  }
}

// UI Orchestration Helpers matching your layout elements
function showStatusOverlay(title, message) {
  const statusScreen = document.getElementById('statusScreen');
  const statusDrawer = document.getElementById('statusDrawer');
  document.getElementById('statusTitle').innerText = title;
  document.getElementById('statusMessage').innerText = message;
  
  statusScreen.classList.remove('pointer-events-none', 'bg-slate-950/0');
  statusScreen.classList.add('bg-slate-950/40', 'backdrop-blur-sm');
  statusDrawer.classList.remove('translate-y-full', 'md:translate-y-8', 'md:opacity-0');
}

function displayStatusScreen(type, title, message) {
  showStatusOverlay(title, message);
  const iconWrap = document.getElementById('statusIconWrap');
  const actionBtn = document.getElementById('statusActionBtn');
  
  actionBtn.classList.remove('hidden');
  actionBtn.onclick = () => {
    const statusScreen = document.getElementById('statusScreen');
    const statusDrawer = document.getElementById('statusDrawer');
    statusScreen.classList.add('pointer-events-none', 'bg-slate-950/0');
    statusDrawer.classList.add('translate-y-full');
    actionBtn.classList.add('hidden');
  };

  if (type === 'error') {
    iconWrap.innerHTML = `
      <svg class="w-10 h-10 text-red-600 status-icon-pop" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
        <path class="status-cross-path" stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
      </svg>
    `;
    iconWrap.className = "w-20 h-20 rounded-full flex items-center justify-center my-4 bg-red-50";
  }
}

function displayStatusSuccess() {
  displayStatusScreen('success', 'Application Received', 'Your admissions document has been generated securely.');
  const iconWrap = document.getElementById('statusIconWrap');
  iconWrap.innerHTML = `
    <svg class="w-10 h-10 text-emerald-600 status-icon-pop" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
      <path class="status-check-path" stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/>
    </svg>
  `;
  iconWrap.className = "w-20 h-20 rounded-full flex items-center justify-center my-4 bg-emerald-50";
}
