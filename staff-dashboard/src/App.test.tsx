import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
beforeEach(() => {
  Object.defineProperty(AbortSignal, 'timeout', { configurable:true, value:() => new AbortController().signal });
  global.fetch = jest.fn();
});
afterEach(() => { sessionStorage.clear(); jest.restoreAllMocks(); });
const response = (data: object, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => data } as Response);
const ticket = (id: string, number: string, machine: string) => ({ id, ticketNumber:number, machine, sequence:Number(number.slice(2)), status:'queued', revision:1, customerName:'Volunteer', department:'Events', purpose:`Design ${number}`, neededBy:'Today', createdAt:`2026-10-22T10:0${number.endsWith('2') ? '2' : '1'}:00Z`, paperType:'Glossy', thickness:2, width:24, length:36, quantity:1, files:[], notes:'', phone:'' });
test('requires staff authentication instead of showing prototype tickets', async () => {
  sessionStorage.setItem('workshop.pagesSession', '1');
  (global.fetch as jest.Mock).mockImplementation(() => response({error:'Sign in to the staff desk.'},401));
  render(<App />);
  expect(await screen.findByText('Welcome to the workshop.')).toBeInTheDocument();
  expect(screen.getByLabelText('Password')).toHaveAttribute('type','password');
  expect(screen.queryByText('Printing requests')).not.toBeInTheDocument();
});
test('keeps FIFO position through search and separates foam jobs', async () => {
  (global.fetch as jest.Mock).mockImplementation(() => response({tickets:[ticket('b','P-0002','printer'),ticket('f','F-0001','foam'),ticket('a','P-0001','printer')],source:'google',updatedAt:'2026-10-22T12:00:00Z'}));
  render(<App />);
  await screen.findByText('Printing requests');
  fireEvent.change(screen.getByLabelText('Search tickets'),{target:{value:'P-0002'}});
  fireEvent.click(screen.getByRole('button',{name:'2 P-0002'}));
  expect(screen.getByRole('button',{name:'Start this job'})).toBeEnabled();
  expect(screen.queryByText('Phone')).not.toBeInTheDocument();
  expect(screen.queryByText('Requested deadline')).not.toBeInTheDocument();
  expect(screen.queryByText('Glossy')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Close ✕'}));
  fireEvent.change(screen.getByLabelText('Search tickets'),{target:{value:''}});
  fireEvent.click(screen.getByRole('button',{name:/Foam cutting/}));
  fireEvent.click(screen.getByRole('button',{name:'1 F-0001'}));
  expect(screen.getByRole('button',{name:'Start this job'})).toBeEnabled();
  expect(screen.getByText(/No file attached/)).toBeInTheDocument();
});
test('a failed refresh shows stale-data warning and disables starting a job', async () => {
  (global.fetch as jest.Mock).mockImplementationOnce(() => response({tickets:[ticket('a','P-0001','printer')],source:'google',updatedAt:'2026-10-22T12:00:00Z'})).mockImplementation(() => Promise.reject(new Error('Offline')));
  render(<App />); await screen.findByText('Printing requests');
  fireEvent.click(screen.getByRole('button',{name:'↻ Refresh'}));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Offline'));
  fireEvent.click(screen.getByRole('button',{name:'1 P-0001'}));
  expect(screen.getByRole('button',{name:'Start this job'})).toBeDisabled();
});

test('archives closed tickets and keeps them available in the Archive view', async () => {
  const closed={...ticket('closed','P-0004','printer'),status:'collected',revision:6,history:[{status:'collected',at:'2026-10-22T12:00:00Z'}]};
  const archived={...ticket('old','P-0005','printer'),status:'archived',revision:7,history:[{status:'archived',at:'2026-10-22T13:00:00Z'}]};
  jest.spyOn(window,'confirm').mockReturnValue(true);
  (global.fetch as jest.Mock).mockImplementation((_url:string, options?:RequestInit) => {
    if (options?.method === 'PATCH') {
      const body=JSON.parse(String(options.body));
      expect(body).toEqual(expect.objectContaining({status:'archived',expectedRevision:6}));
      return response({ticket:{...closed,status:'archived',revision:7,history:[...closed.history,{status:'archived',at:'2026-10-22T14:00:00Z'}]}});
    }
    return response({tickets:[closed,archived],source:'google',updatedAt:'2026-10-22T12:00:00Z'});
  });
  render(<App/>); await screen.findByText('Printing requests');
  fireEvent.click(screen.getByRole('button',{name:'History'}));
  fireEvent.click(screen.getByRole('button',{name:'P-0004'}));
  fireEvent.click(screen.getByRole('button',{name:'Archive ticket'}));
  await waitFor(()=>expect(global.fetch).toHaveBeenCalledWith('/api/tickets/closed',expect.objectContaining({method:'PATCH'})));
  await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Ticket P-0004'})).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole('button',{name:'Archive (2)'}));
  expect(screen.getByRole('button',{name:'P-0004'})).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'P-0005'})).toBeInTheDocument();
});

test('admins see review inbox while production queue contains approved jobs only', async()=>{
  const pending={...ticket('r','P-0003','printer'),status:'pending-review',paperType:''};
  (global.fetch as jest.Mock).mockImplementation((url:string)=>response(url.endsWith('/api/admin/requests')?{tickets:[pending]}:{tickets:[],role:'admin',source:'google',updatedAt:'2026-10-22T12:00:00Z'}));
  render(<App/>); await screen.findByText('Printing requests');
  expect(screen.queryByText('Design P-0003')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:/Admin review/}));
  fireEvent.click(screen.getByRole('button',{name:/P-0003/}));
  expect(screen.getByRole('button',{name:'Approve for staff queue'})).toBeDisabled();
  expect(screen.queryByLabelText('Mobile phone')).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/Requested deadline/)).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Paper material')).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText(/I checked the artwork quality/));
  expect(screen.getByRole('button',{name:'Approve for staff queue'})).toBeEnabled();
});
